// =====================================================
// BitBudCoin Core
// block.js
// =====================================================

const crypto = require("crypto");

class Block {
    constructor(index, timestamp, transactions, previousHash, difficulty, nonce = 0) {
        this.index = index;
        this.timestamp = timestamp;
        this.transactions = transactions;
        this.previousHash = previousHash;
        this.difficulty = difficulty;
        this.nonce = nonce;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        const data =
            this.index +
            this.timestamp +
            JSON.stringify(this.transactions) +
            this.previousHash +
            this.nonce +
            this.difficulty;

        return crypto.createHash("sha256").update(data).digest("hex");
    }

    mineBlock() {
        const target = "0".repeat(this.difficulty);

        while (!this.hash.startsWith(target)) {
            this.nonce++;
            this.hash = this.calculateHash();
        }

        return this;
    }
}

module.exports = Block;