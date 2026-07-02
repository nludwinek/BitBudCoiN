// =====================================================
// BitBudCoin Backend - Pełna wersja
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

// ====================== PODSTAWOWE ENDPOINTY ======================

app.get("/info", (req, res) => {
    res.json(blockchain.getInfo());
});

app.get("/blocks", (req, res) => {
    res.json(blockchain.chain);
});

app.get("/latest", (req, res) => {
    res.json(blockchain.getLatestBlock());
});

// ====================== TRANSAKCJE ======================

app.post("/transaction", (req, res) => {
    try {
        const result = blockchain.addTransaction(req.body);
        res.json({ 
            status: "success", 
            message: "Transakcja dodana do puli",
            ...result 
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ====================== KOPANIE ======================

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

// ====================== KOPARKI vMax ======================

app.get("/miners/models", (req, res) => {
    res.json([
        {
            id: "vmax1",
            name: "vMax 1",
            hashRate: 25,
            power: 65,
            efficiency: "0.38",
            price: 499,
            color: "#00ffaa"
        },
        {
            id: "vmax2",
            name: "vMax 2 Turbo",
            hashRate: 65,
            power: 140,
            efficiency: "0.46",
            price: 1299,
            color: "#00ccff"
        },
        {
            id: "vmax3",
            name: "vMax 3 Pro",
            hashRate: 120,
            power: 220,
            efficiency: "0.55",
            price: 2499,
            color: "#ff00aa"
        }
    ]);
});

app.post("/mine/start", async (req, res) => {
    const { minerAddress, modelId } = req.body;
    
    const models = {
        "vmax1": { speed: 1200, rewardMultiplier: 1.0 },
        "vmax2": { speed: 800,  rewardMultiplier: 1.8 },
        "vmax3": { speed: 500,  rewardMultiplier: 3.2 }
    };

    const model = models[modelId] || models.vmax1;

    setTimeout(async () => {
        try {
            const block = await blockchain.createNewBlock(minerAddress);
            res.json({
                status: "mined",
                model: modelId,
                modelName: model.name || "vMax",
                blockHeight: block.height,
                hash: block.hash,
                reward: (CONFIG.BLOCK_REWARD * model.rewardMultiplier).toFixed(2)
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }, model.speed);
});

// ====================== URUCHOMIENIE SERWERA ======================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 BitBudCoin Backend uruchomiony na porcie ${PORT}`);
    console.log(`   Sieć: \( {CONFIG.NETWORK_NAME} ( \){CONFIG.SYMBOL})`);
    console.log(`   Dostępne endpointy: /info, /mine, /miners/models, /mine/start`);
});