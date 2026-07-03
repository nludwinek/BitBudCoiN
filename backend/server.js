const express = require("express");
const cors = require("cors");
const Blockchain = require("./bbcblockchain");
const CONFIG = require("./config");
const P2PNode = require("./p2p");
const MiningPool = require("./pool");

const app = express();
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain();
const p2p = new P2PNode(blockchain);
p2p.start();
const pool = new MiningPool(blockchain);

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

app.post("/mine/start", async (req, res) => {
    console.log("Żądanie kopania:", req.body);
    const { minerAddress } = req.body;
    if (!minerAddress) return res.status(400).json({error: "Brak adresu"});

    try {
        const block = await blockchain.createNewBlock(minerAddress);
        p2p.broadcastNewBlock(block);
        res.json({
            status: "mined",
            blockHeight: block.height,
            hash: block.hash,
            reward: block.reward
        });
    } catch (e) {
        console.error("Błąd:", e.message);
        res.status(500).json({error: e.message});
    }
});

app.get("/balance/:address", (req, res) => {
    res.json({
        address: req.params.address,
        balance: blockchain.getBalance(req.params.address)
    });
});

app.get("/peers", (req, res) => res.json(p2p.getStatus()));

app.post("/peers/connect", (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({error: "Brak adresu (oczekiwano \"host:port\")"});
    p2p.connectToPeer(address);
    res.json({status: "connecting", address});
});

app.get("/pool/work", (req, res) => {
    const { minerAddress } = req.query;
    res.json(pool.getWork(minerAddress));
});

app.post("/pool/submit", (req, res) => {
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
const server = app.listen(PORT, () => {
    console.log(`🚀 BBC Backend działa na porcie ${PORT}`);
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
