// =====================================================
// BitBudCoin Core
// bbcblockchain.js
// =====================================================

const Block = require("./block");
const CONFIG = require("./config");
const db = require("./database");
const crypto = require("crypto");

class Blockchain {
    constructor() {
        this.chain = [];
        this.pendingTransactions = [];
        this.initializeChain();
    }

    async initializeChain() {
        const blockCount = db.prepare("SELECT COUNT(*) as count FROM blocks").get().count;

        if (blockCount === 0) {
            console.log("🔨 Tworzenie bloku genesis...");

            const genesisBlock = new Block(
                0,
                "0",
                CONFIG.GENESIS_TRANSACTIONS,
                CONFIG.DIFFICULTY,
                CONFIG.GENESIS_ADDRESS,
                CONFIG.BLOCK_REWARD
            );

            genesisBlock.mine();
            this.saveBlock(genesisBlock);
            this.chain.push(genesisBlock);

            console.log("✅ Genesis block utworzony:", genesisBlock.hash);
            console.log("   Adres genesis:", CONFIG.GENESIS_ADDRESS);
        } else {
            this.loadChainFromDB();
        }
    }

    loadChainFromDB() {
        const blocks = db.prepare("SELECT * FROM blocks ORDER BY height ASC").all();
        this.chain = blocks.map(b => {
            const block = new Block(b.height, b.previousHash, [], b.difficulty, b.miner, b.reward);
            block.timestamp = b.timestamp;
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        });
        console.log(`✅ Wczytano ${this.chain.length} bloków`);
    }

    saveBlock(block) {
        db.prepare(`
            INSERT OR IGNORE INTO blocks 
            (height, hash, previousHash, timestamp, nonce, difficulty, miner, reward)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            block.height, block.hash, block.previousHash, 
            block.timestamp, block.nonce, block.difficulty, 
            block.miner, block.reward
        );
    }

    addTransaction(tx) {
        if (!tx.sender || !tx.receiver || tx.amount <= 0) throw new Error("Nieprawidłowa transakcja");
        this.pendingTransactions.push(tx);
        return { txid: crypto.randomBytes(16).toString('hex') };
    }

    async createNewBlock(minerAddress) {
        const previousBlock = this.getLatestBlock();
        const newBlock = new Block(
            previousBlock.height + 1,
            previousBlock.hash,
            [...this.pendingTransactions],
            CONFIG.DIFFICULTY,
            minerAddress,
            CONFIG.BLOCK_REWARD
        );

        newBlock.mine();
        this.saveBlock(newBlock);
        this.chain.push(newBlock);
        this.pendingTransactions = [];

        console.log(`✅ Wydobyto blok #${newBlock.height}`);
        return newBlock;
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    getInfo() {
        return {
            network: CONFIG.NETWORK_NAME,
            symbol: CONFIG.SYMBOL,
            blocks: this.chain.length,
            pending: this.pendingTransactions.length,
            maxSupply: CONFIG.MAX_SUPPLY
        };
    }
}

module.exports = Blockchain;