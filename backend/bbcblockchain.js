// =====================================================
// BitBudCoin Core
// bbcblockchain.js
// Główna klasa Blockchain
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

    // =============================================
    // INICJALIZACJA ŁAŃCUCHA
    // =============================================
    async initializeChain() {
        const blockCount = db.prepare("SELECT COUNT(*) as count FROM blocks").get().count;

        if (blockCount === 0) {
            // Tworzenie bloku genesis
            console.log("🔨 Tworzenie bloku genesis...");

            const genesisBlock = new Block(
                0,
                "0", // previousHash
                CONFIG.GENESIS_TRANSACTIONS,
                CONFIG.DIFFICULTY,
                CONFIG.GENESIS_ADDRESS,
                CONFIG.BLOCK_REWARD
            );

            genesisBlock.mine();

            // Zapis do bazy
            this.saveBlock(genesisBlock);
            this.chain.push(genesisBlock);

            console.log("✅ Blok genesis utworzony:", genesisBlock.hash);
        } else {
            // Wczytanie istniejącego łańcucha
            this.loadChainFromDB();
        }
    }

    // =============================================
    // WCZYTYWANIE Z BAZY
    // =============================================
    loadChainFromDB() {
        const blocks = db.prepare("SELECT * FROM blocks ORDER BY height ASC").all();

        this.chain = blocks.map(b => {
            const block = new Block(
                b.height,
                b.previousHash,
                [], // transakcje wczytamy osobno jeśli potrzeba
                b.difficulty,
                b.miner,
                b.reward
            );
            block.timestamp = b.timestamp;
            block.nonce = b.nonce;
            block.hash = b.hash;
            return block;
        });

        console.log(`✅ Wczytano ${this.chain.length} bloków z bazy.`);
    }

    // =============================================
    // ZAPIS BLOKU DO BAZY
    // =============================================
    saveBlock(block) {
        db.prepare(`
            INSERT INTO blocks (height, hash, previousHash, timestamp, nonce, difficulty, miner, reward)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            block.height,
            block.hash,
            block.previousHash,
            block.timestamp,
            block.nonce,
            block.difficulty,
            block.miner,
            block.reward
        );
    }

    // =============================================
    // DODAWANIE TRANSAKCJI
    // =============================================
    addTransaction(transaction) {
        // Prosta walidacja
        if (!transaction.sender || !transaction.receiver || transaction.amount <= 0) {
            throw new Error("Nieprawidłowa transakcja");
        }

        this.pendingTransactions.push(transaction);
        return true;
    }

    // =============================================
    // TWORZENIE NOWEGO BLOKU
    // =============================================
    async createNewBlock(minerAddress) {
        const previousBlock = this.getLatestBlock();

        const newBlock = new Block(
            previousBlock.height + 1,
            previousBlock.hash,
            [...this.pendingTransactions], // kopia transakcji
            CONFIG.DIFFICULTY,
            minerAddress,
            CONFIG.BLOCK_REWARD
        );

        console.log(`⛏️  Kopanie bloku #${newBlock.height}...`);
        newBlock.mine();

        // Zapis
        this.saveBlock(newBlock);
        this.chain.push(newBlock);

        // Czyszczenie oczekujących transakcji
        this.pendingTransactions = [];

        console.log(`✅ Wydobyto blok #${newBlock.height} | Hash: ${newBlock.hash}`);
        return newBlock;
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    // =============================================
    // WALIDACJA ŁAŃCUCHA
    // =============================================
    isChainValid() {
        for (let i = 1; i < this.chain.length; i++) {
            const currentBlock = this.chain[i];
            const previousBlock = this.chain[i - 1];

            if (currentBlock.hash !== currentBlock.calculateHash()) {
                return false;
            }

            if (currentBlock.previousHash !== previousBlock.hash) {
                return false;
            }
        }
        return true;
    }

    // =============================================
    // INFORMACJE O ŁAŃCUCHU
    // =============================================
    getInfo() {
        return {
            network: CONFIG.NETWORK_NAME,
            symbol: CONFIG.SYMBOL,
            version: CONFIG.VERSION,
            chainLength: this.chain.length,
            pendingTransactions: this.pendingTransactions.length,
            latestBlock: this.getLatestBlock()?.height || 0,
            difficulty: CONFIG.DIFFICULTY
        };
    }
}

module.exports = Blockchain;