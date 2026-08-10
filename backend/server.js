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
const bridgeTags = require("./bridge-tags");
const swapOffers = require("./swap-offers");
const { verifyAcceptOfferSignature, verifyRejectOfferSignature } = require("./swap-offer-auth");
const { verifyHtlcCreateSignature, verifyHtlcClaimSignature, verifyHtlcRefundSignature } = require("./htlc-wallet");

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
const p2p = new P2P(blockchain, CONFIG.P2P_PORT, CONFIG.PEERS);
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

// BEZPIECZEŃSTWO (05.08.2026): brakowało autoryzacji - dowolny caller mógł
// kazać węzłowi łączyć się z dowolnym adresem (SSRF-podobny wektor: skanowanie
// wewnętrznej sieci Oracle Cloud, próby połączenia z localhost/metadanymi
// chmury, itp.). Ten sam ADMIN_SECRET co /bridge/annotations - jedna spójna
// bramka admina, nie druga, osobna.
app.post("/peers/connect", strictLimiter, (req, res) => {
    const { address, secret } = req.body || {};
    if (secret !== bridgeTags.ADMIN_SECRET) {
        return res.status(403).json({ error: "Zły sekret" });
    }
    if (!address || typeof address !== "string" || !address.includes(":")) {
        return res.status(400).json({ error: "Nieprawidłowy adres - oczekiwano formatu host:port" });
    }
    p2p.connectToPeer(address);
    res.json({ ok: true, message: `Próba połączenia z ${address} rozpoczęta` });
});

app.get("/bridge/annotations", (req, res) => {
    res.json(bridgeTags.getAll());
});

app.post("/bridge/annotations", strictLimiter, (req, res) => {
    const { secret, signature, blockHash, to, amount, chain, note } = req.body || {};
    if (secret !== bridgeTags.ADMIN_SECRET) {
        return res.status(403).json({ error: "Zły sekret" });
    }
    try {
        const tag = bridgeTags.addTag({ signature, blockHash, to, amount, chain, note });
        res.json({ ok: true, tag });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
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
    const offer = swapOffers.getOffer(req.params.id);
    if (!offer) return res.status(404).json({ error: "Oferta nie znaleziona" });
    if (!verifyAcceptOfferSignature(req.body, offer.targetSellerAddress)) {
        return res.status(403).json({ error: "Nieprawidłowy podpis - tylko właściciel adresu docelowego może zaakceptować tę ofertę" });
    }
    try {
        const updated = swapOffers.acceptOffer(req.params.id, {
            sellerPubKeyHash: req.body.sellerPubKeyHash,
            sellerBbcAddress: offer.targetSellerAddress
        });
        res.json({ ok: true, offer: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/swap/offers/:id/reject", strictLimiter, (req, res) => {
    const offer = swapOffers.getOffer(req.params.id);
    if (!offer) return res.status(404).json({ error: "Oferta nie znaleziona" });
    if (!verifyRejectOfferSignature(req.body, offer.targetSellerAddress)) {
        return res.status(403).json({ error: "Nieprawidłowy podpis - tylko właściciel adresu docelowego może odrzucić tę ofertę" });
    }
    try {
        const updated = swapOffers.rejectOffer(req.params.id, offer.targetSellerAddress);
        res.json({ ok: true, offer: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get("/transactions/address/:address", (req, res) => {
    res.json(blockchain.getTransactionsForAddress(req.params.address));
});

app.post("/htlc/submit", strictLimiter, (req, res) => {
    const tx = req.body;
    if (!tx || !tx.type) return res.status(400).json({ error: "Brak typu transakcji" });
    if (tx.type === "HTLC_CREATE") {
        // BEZPIECZEŃSTWO (05.08.2026): ten sam wzorzec co przy trudności -
        // "available < tx.amount + fee" z NaN zawsze daje false (sprawdzenie
        // przechodzi niezależnie od kwoty). Podpis potwierdza KTO wysłał, nie
        // że dane mają sens - typ trzeba sprawdzić osobno, jawnie.
        if (typeof tx.amount !== "number" || !(tx.amount > 0)) {
            return res.status(400).json({ error: "Nieprawidłowa kwota" });
        }
        if (!verifyHtlcCreateSignature(tx)) return res.status(400).json({ error: "Nieprawidłowy podpis - transakcja odrzucona" });
        if (blockchain.findHTLC(tx.htlcId)) return res.status(400).json({ error: "HTLC o tym ID już istnieje" });
        const fee = typeof tx.fee === "number" ? tx.fee : 0;
        const available = mempool.getPendingAwareBalance(tx.from);
        if (available < tx.amount + fee) return res.status(400).json({ error: `Niewystarczające saldo (dostępne: ${available})` });
        mempool.addHtlcTransaction(tx);
        return res.json({ accepted: true });
    }
    if (tx.type === "HTLC_CLAIM") {
        if (!verifyHtlcClaimSignature(tx)) return res.status(400).json({ error: "Nieprawidłowy podpis - transakcja odrzucona" });
        const validation = blockchain.validateHTLCClaim({ htlcId: tx.htlcId, secret: tx.secret, claimant: tx.claimant });
        if (!validation.valid) return res.status(400).json({ error: validation.reason });
        mempool.addHtlcTransaction({ ...tx, amount: validation.amount, to: validation.to });
        return res.json({ accepted: true });
    }
    if (tx.type === "HTLC_REFUND") {
        if (!verifyHtlcRefundSignature(tx)) return res.status(400).json({ error: "Nieprawidłowy podpis - transakcja odrzucona" });
        const validation = blockchain.validateHTLCRefund({ htlcId: tx.htlcId, refundee: tx.refundee });
        if (!validation.valid) return res.status(400).json({ error: validation.reason });
        mempool.addHtlcTransaction({ ...tx, amount: validation.amount, to: validation.to });
        return res.json({ accepted: true });
    }
    res.status(400).json({ error: `Nieznany typ transakcji "${tx.type}"` });
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
