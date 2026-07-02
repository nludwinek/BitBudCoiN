const express = require("express");
const cors = require("cors");
const Blockchain = require("./bbcblockchain");
const CONFIG = require("./config");

const app = express();
app.use(cors());
app.use(express.json());

const blockchain = new Blockchain();

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
        res.json({
            status: "mined",
            blockHeight: block.height,
            hash: block.hash,
            reward: CONFIG.BLOCK_REWARD
        });
    } catch (e) {
        console.error("Błąd:", e.message);
        res.status(500).json({error: e.message});
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 BBC Backend działa na porcie ${PORT}`);
});
