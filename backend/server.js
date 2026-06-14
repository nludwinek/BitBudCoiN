const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

// ENDPOINT MINERA
app.get("/mine", (req, res) => {
    const reward = 50; // nagroda za blok

    // generowanie pseudo-hasha bloku
    const blockHash =
        Math.random().toString(36).substring(2) +
        Math.random().toString(36).substring(2);

    res.json({
        status: "ok",
        reward: reward,
        blockHash: blockHash,
        message: "Block mined successfully"
    });
});

// PORT z Render / Railway
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Mine-Bbc backend running on port ${PORT}`);
});