const express = require("express");
const cors = require("cors");
const Blockchain = require("./bbcblockchain");
const CONFIG = require("./config");
const P2PNode = require("./p2p");
const MiningPool = require("./pool");
const Mempool = require("./mempool");
const { createRateLimiter } = require("./rate-limit");

const app = express();
// Wymagane, gdy serwer stoi za reverse proxy (Caddyfile w tym projekcie) -
// inaczej req.ip to zawsze adres proxy i rate-limit dotyczy wszystkich naraz.
// Jeśli NIE używasz reverse proxy, usuń tę linię.
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain();
const mempool = new Mempool(blockchain, blockchain.storage);
const p2p = new P2PNode(blockchain, { mempool });
p2p.start();
const pool = new MiningPool(blockchain, { mempool });

// /mine/start kopie SYNCHRONICZNIE (realny koszt CPU serwera za każde żądanie) -
// limit bardzo ostry. /pool/work i /pool/submit to normalny, częsty ruch
// prawdziwych górników - limit swobodny. /transactions/send umiarkowany,
// żeby nie zapychać mempoola śmieciowymi przelewami.
const strictLimiter = createRateLimiter({ windowMs: 60_000, max: 5, name: "/mine/start" });
const poolLimiter = createRateLimiter({ windowMs: 60_000, max: 300, name: "puli" });
const txLimiter = createRateLimiter({ windowMs: 60_000, max: 30, name: "transakcji" });
const defaultLimiter = createRateLimiter({ windowMs: 60_000, max: 120, name: "API" });
app.use(defaultLimiter);

// Logging
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    next();
});

app.get("/info", (req, res) => res.json(blockchain.getInfo()));

app.get("/miners/models", (req, res) => {
    res.json([
        {id: "vmax1", name: "vMax 1", hashRate: 25},
        {id: "vmax2", name: "vMax 2 Turbo", hashRate: 65},
        {id: "vmax3", name: "vMax 3 Pro", hashRate: 120}
    ]);
});

app.post("/mine/start", strictLimiter, async (req, res) => {
    console.log("Żądanie kopania:", req.body);
    const { minerAddress } = req.body;
    if (!minerAddress) return res.status(400).json({error: "Brak adresu"});

    try {
        const selected = mempool.selectForBlock();
        const block = await blockchain.createNewBlock(minerAddress, selected);
        mempool.pruneConfirmed(block);
        p2p.broadcastNewBlock(block);
        res.json({
            status: "mined",
            blockHeight: block.height,
            hash: block.hash,
            reward: block.reward,
            transactionsIncluded: selected.length
        });
    } catch (e) {
        console.error("Błąd:", e.message);
        res.status(500).json({error: e.message});
    }
});

app.get("/balance/:address", (req, res) => {
    res.json({
        address: req.params.address,
        balance: blockchain.getBalance(req.params.address),
        pendingAwareBalance: mempool.getPendingAwareBalance(req.params.address)
    });
});

app.post("/transactions/send", txLimiter, (req, res) => {
    const result = mempool.addTransaction(req.body);
    if (!result.accepted) return res.status(400).json(result);
    res.json(result);
});

app.get("/transactions/pending", (req, res) => res.json(mempool.getPending()));

app.get("/peers", (req, res) => res.json(p2p.getStatus()));

app.post("/peers/connect", (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({error: "Brak adresu (oczekiwano \"host:port\")"});
    p2p.connectToPeer(address);
    res.json({status: "connecting", address});
});

app.get("/pool/work", poolLimiter, (req, res) => {
    const { minerAddress } = req.query;
    res.json(pool.getWork(minerAddress));
});

app.post("/pool/submit", poolLimiter, (req, res) => {
    const { minerAddress, candidate } = req.body;
    if (!minerAddress) return res.status(400).json({error: "Brak adresu górnika"});
    if (!candidate) return res.status(400).json({error: "Brak pola candidate (wykopany szablon + nonce/hash)"});

    const result = pool.submitShare(minerAddress, candidate);
    if (result.blockFound) {
        p2p.broadcastNewBlock(result.block);
        console.log(`⛏️  Pula znalazła blok #${result.block.height} dzięki ${minerAddress}`);
    }
    res.json(result);
});

app.get("/pool/status", (req, res) => res.json(pool.getStatus()));

app.get("/pool/credits/:address", (req, res) => res.json(pool.getCredits(req.params.address)));

const PORT = CONFIG.API_PORT;
// Domyślnie tylko localhost - Caddy/nginx (Caddyfile w tym projekcie) łączy się
// z tym samym hostem po loopbacku. Jeśli proxy działa na INNEJ maszynie/kontenerze,
// ustaw HOST=0.0.0.0 (i zabezpiecz to firewallem).
const HOST = process.env.HOST || "127.0.0.1";
const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 BBC Backend działa na ${HOST}:${PORT}`);
});

// Łagodne zamknięcie - domykamy P2P i bazę, żeby nie zostawić otwartych gniazd/pliku
function shutdown() {
    console.log("\n🛑 Zamykanie serwera...");
    server.close(() => {
        p2p.close();
        blockchain.close();
        process.exit(0);
    });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
