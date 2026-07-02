// =====================================================
// BitBudCoin Backend
// server.js
// =====================================================

const express = require("express");
const cors = require("cors");
const Blockchain = require("./bbcblockchain");
const CONFIG = require("./config");

const app = express();
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain();

// ====================== API ======================

// Info o sieci
app.get("/info", (req, res) => res.json(blockchain.getInfo()));

// Wydobycie bloku
app.get("/mine", async (req, res) => {
    const miner = req.query.miner || CONFIG.GENESIS_ADDRESS;
    try {
        const block = await blockchain.createNewBlock(miner);
        res.json({
            status: "success",
            message: "Block mined!",
            block: {
                height: block.height,
                hash: block.hash,
                miner: block.miner,
                reward: block.reward,
                transactions: block.transactions.length
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Dodaj transakcję
app.post("/transaction", (req, res) => {
    try {
        const result = blockchain.addTransaction(req.body);
        res.json({ status: "success", ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Lista bloków
app.get("/blocks", (req, res) => {
    res.json(blockchain.chain);
});

// Najnowszy blok
app.get("/latest", (req, res) => {
    res.json(blockchain.getLatestBlock());
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 BitBudCoin Backend działa na http://localhost:${PORT}`);
    console.log(`   Sieć: \( {CONFIG.NETWORK_NAME} ( \){CONFIG.SYMBOL})`);
});