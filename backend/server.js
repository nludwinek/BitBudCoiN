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
const swapOffers = require("./swap-offers");

const app = express();
const defaultJsonParser = express.json();
const poolSubmitJsonParser = express.json({ limit: "512kb" });

app.use(cors());
app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/pool/submit") return next();
    defaultJsonParser(req, res, next);
});
app.use(rateLimiter);

const blockchain = new Blockchain();
const mempool = new Mempool(blockchain, blockchain.storage);
const pool = new Pool(blockchain, { mempool, poolAddress: CONFIG.POOL_ADDRESS, poolFee: CONFIG.POOL_FEE, shareDifficulty: CONFIG.SHARE_DIFFICULTY });
const p2p = new P2P(blockchain, {
    port: CONFIG.P2P_PORT,
    peers: CONFIG.PEERS,
    mempool
});
p2p.start();
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

app.get("/pool/status", (req, res) => {
    const status = pool.getStatus();
    const poolMiners = Object.entries(status.sharesThisRound || {}).map(([address, shares]) => ({
        minerAddress: address, shares, source: "pool"
    }));
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

app.get("/network/addresses", (req, res) => {
    res.json(blockchain.getAddressStats());
});

app.get("/stats/new-addresses", (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 90);
    res.json(blockchain.storage.getNewAddressesPerDay(days));
});

app.get("/stats/active-addresses", (req, res) => {
    res.json(blockchain.storage.getActiveAddresses24h());
});

app.get("/peers", (req, res) => {
    res.json(p2p.getStatus());
});

// Tymczasowo wyłączone: brak modułu bridge-tags.
app.post("/peers/connect", strictLimiter, (req, res) => {
    res.status(503).json({ error: "Funkcja tymczasowo wyłączona: brak bridge-tags" });
});

app.get("/bridge/annotations", (req, res) => {
    res.status(503).json({ error: "Funkcja tymczasowo wyłączona: brak bridge-tags" });
});

app.post("/bridge/annotations", strictLimiter, (req, res) => {
    res.status(503).json({ error: "Funkcja tymczasowo wyłączona: brak bridge-tags" });
});

app.get("/swap/offers", (req, res) => {
    res.json(swapOffers.getAll());
});

app.get("/swap/offers/:id", (req, res) => {
    const offer = swapOffers.getOffer(req.params.id);
    if (!offer) return res.status(404).json({ error: "Oferta nie znaleziona" });
    res.json(offer);
});

app.post("/swap/offers", strictLimiter, (req, res) => {
    const { chain, bbcAmount, expectedAmount, timeoutHours, note, targetSellerAddress } = req.body || {};
    try {
        const offer = swapOffers.createOffer({ chain, bbcAmount, expectedAmount, timeoutHours, note, targetSellerAddress });
        res.json({ ok: true, offer });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/swap/offers/:id/accept", strictLimiter, (req, res) => {
    res.status(503).json({ error: "Funkcja tymczasowo wyłączona: brak swap-offer-auth" });
});

app.post("/swap/offers/:id/reject", strictLimiter, (req, res) => {
    res.status(503).json({ error: "Funkcja tymczasowo wyłączona: brak swap-offer-auth" });
});

app.get("/transactions/address/:address", (req, res) => {
    res.json(blockchain.getTransactionsForAddress(req.params.address));
});

app.post("/htlc/submit", strictLimiter, (req, res) => {
    res.status(503).json({ error: "Funkcja tymczasowo wyłączona: brak htlc-wallet" });
});

app.get("/htlc/:id", (req, res) => {
    const htlc = blockchain.findHTLC(req.params.id);
    if (!htlc) return res.status(404).json({ error: "HTLC nie znaleziony" });
    res.json(htlc);
});

app.get("/pool/work", (req, res) => {
    const minerAddress = req.query.minerAddress;
    if (!minerAddress) return res.status(400).json({ error: "Brak adresu" });
    res.json(pool.getWork(minerAddress));
});

// Limit podniesiony do 05.08.2026: kopanie to legalnie wysoka częstotliwość
// zapytań (share co kilka-kilkanaście sekund NA GÓRNIKA, a kilku górników
// za jednym CGNAT-owym IP to normalka). strictLimiter (60/min) dławił
// prawdziwe kopanie - te dwie trasy zostają tylko na ogólnym rateLimiter
// (1000/min), zastosowanym już globalnie przez app.use() wyżej.
app.post("/pool/submit", poolSubmitJsonParser, (req, res) => {
    const result = pool.submitShare(req.body.minerAddress, req.body.candidate);
    if (!result.accepted) return res.status(400).json(result);
    if (result.blockFound) p2p.broadcastNewBlock(result.block);
    res.json(result);
});

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

app.post("/solo/submit", (req, res) => {
    const { candidate } = req.body;
    if (!candidate) return res.status(400).json({ error: "Brak candidate" });
    const result = blockchain.receiveBlock(candidate);
    if (!result.accepted) return res.status(400).json(result);
    mempool.pruneConfirmed(result.block);
    p2p.broadcastNewBlock(result.block);
    res.json({ status: "mined", blockHeight: result.block.height, hash: result.block.hash, reward: result.block.transactions[0].amount });
});

app.post("/solo/heartbeat", (req, res) => {
    const { minerAddress, attempts, intervalSeconds } = req.body || {};
    if (!minerAddress) return res.status(400).json({ error: "Brak adresu" });
    soloTracker.heartbeat(minerAddress, attempts, intervalSeconds);
    res.json({ ok: true });
});

app.post("/mine/start", strictLimiter, (req, res) => {
    res.status(410).json({ error: "Solo mining wyłączone przy tej trudności - użyj kopania przez pulę lub /solo/work (miner.html)" });
});

app.get("/miners/models", (req, res) => res.json([]));

// STABILNOŚĆ (05.08.2026): globalny error handler - bez tego jeden
// nieprzewidziany wyjątek w dowolnym route (mempool/pool/p2p/storage) leciał
// jako domyślna strona błędu Express zamiast czystego JSON-a, a przy
// niektórych typach błędów mógł ubić cały proces. Łapie wszystko synchroniczne
// (Express 4 sam to robi dla handlerów bez async/await - a tu żaden handler
// nie używa async/await). Jeśli w przyszłości pojawi się handler z async,
// będzie potrzebował własnego try/catch + next(err), ten handler sam z siebie
// złapie tylko rzuty synchroniczne.
app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") {
        return res.status(413).json({ error: "Request body too large" });
    }
    console.error("Nieobsłużony błąd:", err);
    res.status(500).json({ error: "Wewnętrzny błąd serwera" });
});

app.listen(CONFIG.API_PORT, "127.0.0.1", () => {
    console.log(`BitBudCoin API nasłuchuje na porcie ${CONFIG.API_PORT}`);
});

module.exports = { app, blockchain, mempool, pool, p2p };
