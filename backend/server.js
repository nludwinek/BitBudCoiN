const express = require("express");
const cors = require("cors");
const CONFIG = require("./config");
const Blockchain = require("./bbcblockchain");
const Mempool = require("./mempool");
const Pool = require("./pool");
const P2P = require("./p2p");
const SoloTracker = require("./solo-tracker");
const { rateLimiter, strictLimiter } = require("./rate-limit");
const { difficultyToTargetHex } = require("./bbcblockchain");

const app = express();
app.use(cors());
app.use(express.json());
app.use(rateLimiter);

const blockchain = new Blockchain();
const mempool = new Mempool(blockchain, blockchain.storage);
const pool = new Pool(blockchain, mempool, CONFIG.POOL_ADDRESS, CONFIG.POOL_FEE, CONFIG.SHARE_DIFFICULTY);
const p2p = new P2P(blockchain, CONFIG.P2P_PORT, CONFIG.PEERS);
const soloTracker = new SoloTracker();

app.get("/info", (req, res) => res.json(blockchain.getInfo()));

app.get("/blocks", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const before = req.query.before !== undefined ? Number(req.query.before) : null;
    res.json(blockchain.getRecentBlocks(limit, before));
});

app.get("/blocks/:height", (req, res) => {
    const block = blockchain.getChain().find((b) => b.height === Number(req.params.height));
    if (!block) return res.status(404).json({ error: "Blok nie znaleziony" });
    res.json(block);
});

app.get("/balance/:address", (req, res) => {
    const address = req.params.address;
    const confirmed = blockchain.getBalance(address);
    const pending = mempool.getPendingDelta ? mempool.getPendingDelta(address) : 0;
    res.json({ address, balance: confirmed, pendingAwareBalance: confirmed + pending });
});

app.post("/transactions/send", strictLimiter, (req, res) => {
    const result = mempool.addTransaction(req.body);
    if (!result.accepted) return res.status(400).json(result);
    res.json(result);
});

// Status puli + górnicy aktywni "na żywo" - łączy dane z puli (shares) i solo
// (heartbeaty) w jedną listę, oznaczoną polem source, żeby front mógł pokazać
// jeden wspólny widok "kto teraz kopie" niezależnie od trybu.
app.get("/pool/status", (req, res) => {
    const status = pool.getStatus();
    const poolMiners = status.activeMiners.map((m) => ({ ...m, source: "pool" }));
    const soloMiners = soloTracker.getActiveMiners().map((m) => ({ ...m, source: "solo" }));
    res.json({
        ...status,
        activeMiners: [...poolMiners, ...soloMiners],
        soloHashrate: soloTracker.getTotalHashrate()
    });
});

app.get("/network/miners", (req, res) => {
    const poolMiners = blockchain.storage.getKnownPoolMiners().map((m) => ({
        address: m.minerAddress, source: "pool", totalEarned: m.totalCredits,
        lastBlockHeight: m.lastBlockHeight, roundsParticipated: m.roundsParticipated
    }));
    const soloMiners = blockchain.getSoloMiners().map((m) => ({
        address: m.address, source: "solo", totalEarned: m.totalEarned,
        lastBlockHeight: m.lastBlockHeight, blocksFound: m.blocksFound
    }));
    const all = [...poolMiners, ...soloMiners].sort((a, b) => b.lastBlockHeight - a.lastBlockHeight);
    res.json(all);
});

app.get("/pool/work", (req, res) => {
    const minerAddress = req.query.minerAddress;
    if (!minerAddress) return res.status(400).json({ error: "Brak adresu" });
    res.json(pool.getWork(minerAddress));
});

app.post("/pool/submit", strictLimiter, (req, res) => {
    const result = pool.submitShare(req.body.minerAddress, req.body.candidate);
    if (!result.accepted) return res.status(400).json(result);
    if (result.blockFound) p2p.broadcastNewBlock(result.block);
    res.json(result);
});

// Solo (bezpieczne, liczenie po stronie klienta - serwer tylko weryfikuje)
app.get("/solo/work", (req, res) => {
    const minerAddress = req.query.minerAddress;
    if (!minerAddress) return res.status(400).json({ error: "Brak adresu" });
    const latest = blockchain.getLatestBlock();
    const pendingTxs = mempool.selectForBlock();
    res.json({
        height: latest.height + 1, previousHash: latest.hash, timestamp: Date.now(),
        transactions: blockchain.buildBlockTransactions(minerAddress, pendingTxs),
        difficulty: blockchain.difficulty,
        blockTarget: difficultyToTargetHex(blockchain.difficulty)
    });
});

app.post("/solo/submit", strictLimiter, (req, res) => {
    const { candidate } = req.body;
    if (!candidate) return res.status(400).json({ error: "Brak candidate" });
    const result = blockchain.receiveBlock(candidate);
    if (!result.accepted) return res.status(400).json(result);
    mempool.pruneConfirmed(result.block);
    p2p.broadcastNewBlock(result.block);
    res.json({ status: "mined", blockHeight: result.block.height, hash: result.block.hash, reward: result.block.transactions[0].amount });
});

// Lekki "sygnał życia" od solo-minera - nie zgłasza wyniku, tylko tempo,
// żeby serwer wiedział że ktoś aktualnie liczy solo (patrz solo-tracker.js).
app.post("/solo/heartbeat", (req, res) => {
    const { minerAddress, attempts, intervalSeconds } = req.body || {};
    if (!minerAddress) return res.status(400).json({ error: "Brak adresu" });
    soloTracker.heartbeat(minerAddress, attempts, intervalSeconds);
    res.json({ ok: true });
});

// Stare solo mining wyłączone - przy realnej trudności blokowało cały serwer
// (Node.js jest jednowątkowy). Prawdziwe kopanie solo idzie teraz przez
// /solo/work + /solo/submit, gdzie liczenie dzieje się u klienta.
app.post("/mine/start", strictLimiter, (req, res) => {
    res.status(410).json({ error: "Solo mining wyłączone przy tej trudności - użyj kopania przez pulę lub /solo/work (miner.html)" });
});

app.get("/miners/models", (req, res) => res.json([]));

app.listen(CONFIG.API_PORT, "127.0.0.1", () => {
    console.log(`BitBudCoin API nasłuchuje na porcie ${CONFIG.API_PORT}`);
});

module.exports = { app, blockchain, mempool, pool, p2p };
