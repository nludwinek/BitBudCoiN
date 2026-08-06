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
        // Nowe (31.07.2026) - wspierają statystyki adresów (nowe/aktywne w
        // czasie) liczone bezpośrednio w bazie, nie przez ściąganie
        // wszystkich transakcji do przeglądarki.
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address)");

        // Dokładna kopia bloków otrzymanych przez P2P.
        // JSON zachowuje kolejność i komplet pól historycznych transakcji.
        this.db.exec(`CREATE TABLE IF NOT EXISTS raw_chain_blocks (
            height INTEGER PRIMARY KEY,
            block_json TEXT NOT NULL
        )`);

        // Metadane węzła, m.in. informacje o legacy snapshot.
        this.db.exec(`CREATE TABLE IF NOT EXISTS node_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);

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

    saveBlockWithRaw(block) {
        this.db.exec("BEGIN");
        try {
            this.db.prepare(
                "INSERT OR REPLACE INTO raw_chain_blocks (height, block_json) VALUES (?, ?)"
            ).run(block.height, JSON.stringify(block));

            this._insertBlock.run(
                block.height,
                block.timestamp,
                block.previousHash,
                block.hash,
                block.nonce,
                block.difficulty
            );

            for (const tx of block.transactions) {
                this._insertTx.run(
                    block.height,
                    tx.from ?? null,
                    tx.to,
                    tx.amount,
                    tx.type,
                    tx.fee ?? null,
                    tx.timestamp ?? null,
                    tx.publicKey ?? null,
                    tx.signature ?? null
                );
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

    // ============ Statystyki adresów (31.07.2026) ============
    // "Pierwsze pojawienie się" adresu = najwcześniejszy moment, w którym
    // wystąpił jako from_address LUB to_address w dowolnej transakcji.
    // KRYTYCZNE: transakcje coinbase (nagrody za blok - najczęstszy sposób,
    // w jaki NOWY adres w ogóle się pojawia) nie mają własnego timestamp,
    // tylko blockHeight - stąd COALESCE do timestamp bloku przez JOIN.
    // Bez tego każdy górnik, który jeszcze nic nie wysłał, byłby całkowicie
    // pomijany w tych statystykach.
    _addressEventsCTE() {
        return `
            WITH address_events AS (
                SELECT t.to_address AS address, COALESCE(t.timestamp, b.timestamp) AS ts
                FROM transactions t JOIN blocks b ON t.blockHeight = b.height
                WHERE t.to_address IS NOT NULL
                UNION ALL
                SELECT t.from_address AS address, COALESCE(t.timestamp, b.timestamp) AS ts
                FROM transactions t JOIN blocks b ON t.blockHeight = b.height
                WHERE t.from_address IS NOT NULL
            )
        `;
    }

    // Zwraca [{day: "YYYY-MM-DD", newAddresses: N}, ...], malejąco po dacie.
    getNewAddressesPerDay(days = 30) {
        const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
        return this.db.prepare(`
            ${this._addressEventsCTE()},
            first_seen AS (SELECT address, MIN(ts) AS first_ts FROM address_events GROUP BY address)
            SELECT date(first_ts / 1000, 'unixepoch') AS day, COUNT(*) AS newAddresses
            FROM first_seen
            WHERE first_ts >= ?
            GROUP BY day
            ORDER BY day DESC
        `).all(sinceMs);
    }

    // Zwraca { totalActive, top: [{address, events, lastActive}, ...] } -
    // "events" to liczba transakcji (jako nadawca lub odbiorca) w oknie,
    // nie prawdziwe shares - dobre przybliżenie aktywności, nie dokładna
    // miara mocy obliczeniowej (do tego służy już istniejący /pool/status).
    getActiveAddresses24h(topLimit = 5) {
        const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
        const rows = this.db.prepare(`
            ${this._addressEventsCTE()}
            SELECT address, COUNT(*) AS events, MAX(ts) AS lastActive
            FROM address_events
            WHERE ts >= ?
            GROUP BY address
            ORDER BY events DESC
        `).all(sinceMs);
        return { totalActive: rows.length, top: rows.slice(0, topLimit) };
    }

    hasRawChain() {
        return this.db.prepare(
            "SELECT COUNT(*) AS n FROM raw_chain_blocks"
        ).get().n > 0;
    }

    loadRawChain() {
        return this.db.prepare(
            "SELECT block_json FROM raw_chain_blocks ORDER BY height ASC"
        ).all().map((row) => JSON.parse(row.block_json));
    }

    saveRawBlock(block) {
        this.db.prepare(
            "INSERT OR REPLACE INTO raw_chain_blocks (height, block_json) VALUES (?, ?)"
        ).run(block.height, JSON.stringify(block));
    }

    replaceRawChain(chain) {
        this.db.exec("BEGIN");
        try {
            this.db.exec("DELETE FROM raw_chain_blocks");

            const insert = this.db.prepare(
                "INSERT INTO raw_chain_blocks (height, block_json) VALUES (?, ?)"
            );

            for (const block of chain) {
                insert.run(block.height, JSON.stringify(block));
            }

            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    setMeta(key, value) {
        this.db.prepare(
            "INSERT OR REPLACE INTO node_meta (key, value) VALUES (?, ?)"
        ).run(key, JSON.stringify(value));
    }

    getMeta(key, fallback = null) {
        const row = this.db.prepare(
            "SELECT value FROM node_meta WHERE key = ?"
        ).get(key);

        if (!row) return fallback;

        try {
            return JSON.parse(row.value);
        } catch {
            return row.value;
        }
    }

    close() { this.db.close(); }
}

module.exports = Storage;
