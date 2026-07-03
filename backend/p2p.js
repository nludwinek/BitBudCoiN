const net = require("net");
const CONFIG = require("./config");

// Zabezpieczenie przed złośliwym/zepsutym peerem, który nigdy nie wysyła "\n" -
// bez tego bufor rósłby w nieskończoność
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Ile trzymamy w pamięci hashy ostatnio widzianych bloków (dedup gossipu NEW_BLOCK)
const SEEN_HASHES_CAP = 5000;

const RECONNECT_DELAY_MS = 5000;

/**
 * Węzeł P2P: surowe gniazda TCP (net), wiadomości jako JSON oddzielony znakiem
 * nowej linii (NDJSON). Nie WebSocket - żeby nie dokładać zależności npm, a Node
 * ma to wbudowane. Protokół:
 *   HELLO      { height, latestHash, genesisHash }   - wysyłane od razu po połączeniu
 *   GET_CHAIN  {}                                     - "wyślij mi cały swój łańcuch"
 *   CHAIN      { chain: [...] }                       - odpowiedź na GET_CHAIN
 *   NEW_BLOCK  { block }                               - propagacja świeżo wykopanego bloku
 */
class P2PNode {
    constructor(blockchain, { port, peers } = {}) {
        this.blockchain = blockchain;
        this.port = port ?? CONFIG.P2P_PORT;
        this.initialPeers = peers ?? CONFIG.PEERS ?? [];

        this.sockets = new Map(); // adres "host:port" -> net.Socket
        this.configuredPeers = new Set(); // adresy, do których SAMI się łączymy (dostają retry)
        this.reconnectTimers = new Map();
        this.seenBlockHashes = new Set();
        this.server = null;
        this.closed = false;
    }

    start() {
        this.server = net.createServer((socket) => {
            const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
            this._handleConnection(socket, remoteAddr);
        });

        this.server.on("error", (err) => {
            console.error(`❌ Błąd serwera P2P: ${err.message}`);
        });

        this.server.listen(this.port, () => {
            console.log(`🌐 Węzeł P2P nasłuchuje na porcie ${this.port}`);
        });

        for (const addr of this.initialPeers) {
            this.connectToPeer(addr);
        }
    }

    // Łączy się z peerem "host:port". Bezpieczne do wywołania wielokrotnie -
    // pomija, jeśli już połączeni. Nieudane połączenie i późniejszy rozłącznik
    // uruchamiają automatyczny retry co RECONNECT_DELAY_MS.
    connectToPeer(address) {
        if (this.closed || this.sockets.has(address)) return;
        this.configuredPeers.add(address);

        const [host, portStr] = address.split(":");
        const socket = net.connect(Number(portStr), host);

        socket.on("connect", () => {
            console.log(`🔗 Połączono z peerem ${address}`);
            this._clearReconnect(address);
            this._handleConnection(socket, address);
        });

        socket.on("error", (err) => {
            console.warn(`⚠️  Problem z połączeniem do ${address}: ${err.message}`);
        });

        socket.on("close", () => {
            this.sockets.delete(address);
            if (!this.closed) this._scheduleReconnect(address);
        });
    }

    _scheduleReconnect(address) {
        if (this.reconnectTimers.has(address)) return;
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(address);
            this.connectToPeer(address);
        }, RECONNECT_DELAY_MS);
        timer.unref();
        this.reconnectTimers.set(address, timer);
    }

    _clearReconnect(address) {
        const timer = this.reconnectTimers.get(address);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(address);
        }
    }

    // Wspólna obsługa gniazda - zarówno dla połączeń przychodzących (od razu),
    // jak i wychodzących (wołane dopiero po evencie "connect")
    _handleConnection(socket, remoteAddr) {
        this.sockets.set(remoteAddr, socket);
        let buffer = "";

        this._send(socket, this._helloMessage());

        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            if (buffer.length > MAX_BUFFER_BYTES) {
                console.warn(`⚠️  Peer ${remoteAddr} przekroczył limit bufora wiadomości - rozłączam`);
                socket.destroy();
                return;
            }
            let idx;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.trim()) this._handleMessage(socket, remoteAddr, line);
            }
        });

        socket.on("close", () => {
            this.sockets.delete(remoteAddr);
            console.log(`🔌 Peer ${remoteAddr} rozłączony`);
        });

        socket.on("error", () => {
            // "close" i tak zaraz się odpali - to tylko po to, żeby nieobsłużony
            // błąd nie wywrócił całego procesu
        });
    }

    _helloMessage() {
        const latest = this.blockchain.getLatestBlock();
        return {
            type: "HELLO",
            height: latest.height,
            latestHash: latest.hash,
            genesisHash: this.blockchain.chain[0].hash
        };
    }

    _serializeBlock(block) {
        return {
            height: block.height,
            timestamp: block.timestamp,
            previousHash: block.previousHash,
            hash: block.hash,
            nonce: block.nonce,
            difficulty: block.difficulty,
            transactions: block.transactions
        };
    }

    _send(socket, message) {
        try {
            socket.write(JSON.stringify(message) + "\n");
        } catch (err) {
            // socket mógł się właśnie zamknąć - ignorujemy
        }
    }

    broadcast(message, excludeAddr = null) {
        const line = JSON.stringify(message) + "\n";
        for (const [addr, socket] of this.sockets) {
            if (addr === excludeAddr) continue;
            try {
                socket.write(line);
            } catch (err) {
                // ignorujemy pojedynczy zerwany socket, reszта peerów dostanie wiadomość
            }
        }
    }

    // Wołane przez server.js zaraz po tym, jak SAMI wykopiemy nowy blok
    broadcastNewBlock(block) {
        const serialized = this._serializeBlock(block);
        this._rememberHash(serialized.hash);
        this.broadcast({ type: "NEW_BLOCK", block: serialized });
    }

    _rememberHash(hash) {
        if (this.seenBlockHashes.size > SEEN_HASHES_CAP) this.seenBlockHashes.clear();
        this.seenBlockHashes.add(hash);
    }

    _handleMessage(socket, remoteAddr, line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (err) {
            console.warn(`⚠️  Nieprawidłowy JSON od ${remoteAddr}`);
            return;
        }

        try {
            this._dispatch(socket, remoteAddr, message);
        } catch (err) {
            console.warn(`⚠️  Błąd przetwarzania wiadomości od ${remoteAddr}: ${err.message}`);
        }
    }

    _dispatch(socket, remoteAddr, message) {
        switch (message.type) {
            case "HELLO": {
                const ourGenesis = this.blockchain.chain[0].hash;
                if (message.genesisHash && message.genesisHash !== ourGenesis) {
                    console.warn(`⚠️  ${remoteAddr} ma inny genesis (inna sieć) - ignoruję`);
                    return;
                }
                const ourHeight = this.blockchain.getLatestBlock().height;
                if (typeof message.height === "number" && message.height > ourHeight) {
                    this._send(socket, { type: "GET_CHAIN" });
                }
                break;
            }

            case "GET_CHAIN": {
                this._send(socket, {
                    type: "CHAIN",
                    chain: this.blockchain.getChain().map((b) => this._serializeBlock(b))
                });
                break;
            }

            case "CHAIN": {
                const result = this.blockchain.replaceChain(message.chain);
                if (result.accepted) {
                    console.log(`✅ Przyjęto dłuższy łańcuch od ${remoteAddr} - nowa wysokość ${result.height}`);
                } else {
                    console.log(`↪️  Odrzucono łańcuch od ${remoteAddr}: ${result.reason}`);
                }
                break;
            }

            case "NEW_BLOCK": {
                const b = message.block;
                if (!b || !b.hash || this.seenBlockHashes.has(b.hash)) return;
                this._rememberHash(b.hash);

                const ourHeight = this.blockchain.getLatestBlock().height;
                if (b.height === ourHeight + 1) {
                    const result = this.blockchain.receiveBlock(b);
                    if (result.accepted) {
                        console.log(`⛏️  Przyjęto nowy blok #${b.height} od ${remoteAddr}`);
                        this.broadcast({ type: "NEW_BLOCK", block: b }, remoteAddr);
                    } else {
                        console.log(`↪️  Odrzucono blok #${b.height} od ${remoteAddr}: ${result.reason}`);
                    }
                } else if (b.height > ourHeight + 1) {
                    console.log(`📡 ${remoteAddr} jest do przodu (#${b.height}, my #${ourHeight}) - proszę o cały łańcuch`);
                    this._send(socket, { type: "GET_CHAIN" });
                }
                break;
            }

            default:
                console.warn(`⚠️  Nieznany typ wiadomości od ${remoteAddr}: ${message.type}`);
        }
    }

    getStatus() {
        return {
            port: this.port,
            connected: Array.from(this.sockets.keys()),
            configured: Array.from(this.configuredPeers),
            reconnecting: Array.from(this.reconnectTimers.keys())
        };
    }

    close() {
        this.closed = true;
        for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
        this.reconnectTimers.clear();
        for (const socket of this.sockets.values()) socket.destroy();
        this.sockets.clear();
        if (this.server) this.server.close();
    }
}

module.exports = P2PNode;
