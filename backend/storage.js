const { DatabaseSync } = require("node:sqlite");

/**
 * Cienka warstwa nad SQLite (node:sqlite - wbudowane w Node 22+, eksperymentalne,
 * ale synchroniczne i bez żadnej dodatkowej zależności w package.json).
 *
 * Łańcuch nadal żyje w pamięci (Blockchain.chain) - to jest tylko zapis/odczyt
 * tego stanu, żeby przeżył restart procesu. Baza nie jest "źródłem prawdy" w locie,
 * jest kopią zapasową odtwarzaną przy starcie.
 */
class Storage {
    constructor(path) {
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        this._initSchema();
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS blocks (
                height INTEGER PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                previousHash TEXT NOT NULL,
                hash TEXT NOT NULL,
                nonce INTEGER NOT NULL,
                difficulty REAL NOT NULL
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                blockHeight INTEGER NOT NULL,
                from_address TEXT,
                to_address TEXT NOT NULL,
                amount REAL NOT NULL,
                type TEXT NOT NULL,
                FOREIGN KEY (blockHeight) REFERENCES blocks(height)
            )
        `);

        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(blockHeight)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address)");

        this._insertBlock = this.db.prepare(
            "INSERT INTO blocks (height, timestamp, previousHash, hash, nonce, difficulty) VALUES (?, ?, ?, ?, ?, ?)"
        );
        this._insertTx = this.db.prepare(
            "INSERT INTO transactions (blockHeight, from_address, to_address, amount, type) VALUES (?, ?, ?, ?, ?)"
        );
    }

    hasBlocks() {
        return this.db.prepare("SELECT COUNT(*) AS n FROM blocks").get().n > 0;
    }

    // Zapisuje blok + jego transakcje atomowo (jedna transakcja SQL - albo wszystko, albo nic)
    saveBlock(block) {
        this.db.exec("BEGIN");
        try {
            this._insertBlock.run(
                block.height,
                block.timestamp,
                block.previousHash,
                block.hash,
                block.nonce,
                block.difficulty
            );
            for (const tx of block.transactions) {
                this._insertTx.run(block.height, tx.from ?? null, tx.to, tx.amount, tx.type);
            }
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    // Wczytuje cały łańcuch posortowany rosnąco, z transakcjami dociągniętymi do bloków
    loadChain() {
        const blockRows = this.db.prepare("SELECT * FROM blocks ORDER BY height ASC").all();
        const txStmt = this.db.prepare(
            "SELECT * FROM transactions WHERE blockHeight = ? ORDER BY id ASC"
        );

        return blockRows.map((row) => ({
            height: row.height,
            timestamp: row.timestamp,
            previousHash: row.previousHash,
            hash: row.hash,
            nonce: row.nonce,
            difficulty: row.difficulty,
            transactions: txStmt.all(row.height).map((tx) => ({
                from: tx.from_address,
                to: tx.to_address,
                amount: tx.amount,
                type: tx.type
            }))
        }));
    }

    close() {
        this.db.close();
    }
}

module.exports = Storage;
