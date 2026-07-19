const { DatabaseSync } = require("node:sqlite");

class Storage {
    constructor(dbPath) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        this._initSchema();
    }

    _initSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS blocks (
            height INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
            previousHash TEXT NOT NULL, hash TEXT NOT NULL,
            nonce INTEGER NOT NULL, difficulty REAL NOT NULL
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, blockHeight INTEGER NOT NULL,
            from_address TEXT, to_address TEXT NOT NULL, amount REAL NOT NULL,
            type TEXT NOT NULL, fee REAL, timestamp INTEGER, publicKey TEXT, signature TEXT,
            FOREIGN KEY (blockHeight) REFERENCES blocks(height)
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS mempool (
            signature TEXT PRIMARY KEY, from_address TEXT, to_address TEXT,
            amount REAL, fee REAL, timestamp INTEGER, publicKey TEXT
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS pool_credits (
            id INTEGER PRIMARY KEY AUTOINCREMENT, minerAddress TEXT NOT NULL,
            blockHeight INTEGER NOT NULL, shares INTEGER NOT NULL,
            amount REAL NOT NULL, timestamp INTEGER NOT NULL, paid INTEGER DEFAULT 0
        )`);
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(blockHeight)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_credits_miner ON pool_credits(minerAddress)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_credits_paid ON pool_credits(paid)");

        this._insertBlock = this.db.prepare("INSERT INTO blocks (height, timestamp, previousHash, hash, nonce, difficulty) VALUES (?, ?, ?, ?, ?, ?)");
        this._insertTx = this.db.prepare("INSERT INTO transactions (blockHeight, from_address, to_address, amount, type, fee, timestamp, publicKey, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        this._insertCredit = this.db.prepare("INSERT INTO pool_credits (minerAddress, blockHeight, shares, amount, timestamp) VALUES (?, ?, ?, ?, ?)");
    }

    hasBlocks() { return this.db.prepare("SELECT COUNT(*) AS n FROM blocks").get().n > 0; }

    saveBlock(block) {
        this.db.exec("BEGIN");
        try {
            this._insertBlock.run(block.height, block.timestamp, block.previousHash, block.hash, block.nonce, block.difficulty);
            for (const tx of block.transactions) {
                this._insertTx.run(block.height, tx.from ?? null, tx.to, tx.amount, tx.type, tx.fee ?? null, tx.timestamp ?? null, tx.publicKey ?? null, tx.signature ?? null);
            }
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    loadChain() {
        const blockRows = this.db.prepare("SELECT * FROM blocks ORDER BY height ASC").all();
        const txStmt = this.db.prepare("SELECT * FROM transactions WHERE blockHeight = ? ORDER BY id ASC");
        return blockRows.map((row) => ({
            height: row.height, timestamp: row.timestamp, previousHash: row.previousHash,
            hash: row.hash, nonce: row.nonce, difficulty: row.difficulty,
            transactions: txStmt.all(row.height).map((tx) => ({
                from: tx.from_address, to: tx.to_address, amount: tx.amount, type: tx.type,
                fee: tx.fee ?? undefined, timestamp: tx.timestamp ?? undefined,
                publicKey: tx.publicKey ?? undefined, signature: tx.signature ?? undefined
            }))
        }));
    }

    loadMempool() {
        return this.db.prepare("SELECT * FROM mempool").all().map((tx) => ({
            from: tx.from_address, to: tx.to_address, amount: tx.amount,
            fee: tx.fee, timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature
        }));
    }
    saveMempoolTx(tx) {
        this.db.prepare("INSERT OR REPLACE INTO mempool (signature, from_address, to_address, amount, fee, timestamp, publicKey) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(tx.signature, tx.from, tx.to, tx.amount, tx.fee, tx.timestamp, tx.publicKey);
    }
    deleteMempoolTx(signature) { this.db.prepare("DELETE FROM mempool WHERE signature = ?").run(signature); }

    saveCredit(c) { this._insertCredit.run(c.minerAddress, c.blockHeight, c.shares, c.amount, c.timestamp); }

    getKnownPoolMiners() {
        return this.db.prepare(`SELECT minerAddress, SUM(amount) as totalCredits, MAX(blockHeight) as lastBlockHeight, COUNT(*) as roundsParticipated
                                  FROM pool_credits GROUP BY minerAddress ORDER BY lastBlockHeight DESC`).all();
    }

    getUnpaidCreditsSummary() {
        const rows = this.db.prepare("SELECT * FROM pool_credits WHERE paid = 0").all();
        const byAddress = new Map();
        for (const row of rows) {
            const entry = byAddress.get(row.minerAddress) || { minerAddress: row.minerAddress, total: 0, creditIds: [] };
            entry.total += row.amount;
            entry.creditIds.push(row.id);
            byAddress.set(row.minerAddress, entry);
        }
        return Array.from(byAddress.values());
    }
    markCreditsPaid(creditIds) {
        const stmt = this.db.prepare("UPDATE pool_credits SET paid = 1 WHERE id = ?");
        for (const id of creditIds) stmt.run(id);
    }

    close() { this.db.close(); }
}

module.exports = Storage;
