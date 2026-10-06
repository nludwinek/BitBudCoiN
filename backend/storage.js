const { DatabaseSync } = require("node:sqlite");

class Storage {
    constructor(dbPath) {
        this.db = new DatabaseSync(dbPath);

        /*
         * busy_timeout MUSI byc ustawiony przed journal_mode=WAL.
         *
         * PRAGMA journal_mode moze potrzebowac blokady bazy. Gdy dwa
         * procesy PM2/payout startuja jednoczesnie, stara kolejnosc
         * mogla rzucic SQLITE_BUSY zanim timeout zostal w ogole ustawiony.
         */
        this.db.exec("PRAGMA busy_timeout = 5000");
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");

        this._initSchema();
    }

    _initSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS blocks (
            height INTEGER PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            previousHash TEXT NOT NULL,
            hash TEXT NOT NULL,
            nonce INTEGER NOT NULL,
            difficulty REAL NOT NULL
        )`);

        this.db.exec(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            blockHeight INTEGER NOT NULL,
            from_address TEXT,
            to_address TEXT NOT NULL,
            amount REAL NOT NULL,
            type TEXT NOT NULL,
            fee REAL,
            timestamp INTEGER,
            publicKey TEXT,
            signature TEXT,
            FOREIGN KEY (blockHeight) REFERENCES blocks(height)
        )`);

        this.db.exec(`CREATE TABLE IF NOT EXISTS mempool (
            signature TEXT PRIMARY KEY,
            from_address TEXT,
            to_address TEXT,
            amount REAL,
            fee REAL,
            timestamp INTEGER,
            publicKey TEXT,
            receivedAt INTEGER NOT NULL DEFAULT 0
        )`);

        // Migracja istniejącej bazy:
        // CREATE TABLE IF NOT EXISTS nie zmienia już istniejącej tabeli.
        const mempoolColumns = this.db
            .prepare("PRAGMA table_info(mempool)")
            .all();

        const hasReceivedAt = mempoolColumns.some(
            (column) => column.name === "receivedAt"
        );

        if (!hasReceivedAt) {
            this.db.exec(
                "ALTER TABLE mempool ADD COLUMN receivedAt INTEGER NOT NULL DEFAULT 0"
            );
        }

        this.db.exec(`CREATE TABLE IF NOT EXISTS pool_credits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            minerAddress TEXT NOT NULL,
            blockHeight INTEGER NOT NULL,
            shares INTEGER NOT NULL,
            amount REAL NOT NULL,
            timestamp INTEGER NOT NULL,
            paid INTEGER DEFAULT 0
        )`);

        // "Rodzina BbC" - napisane wczesniej, nigdy nie wdrozone (family-chat.js
        // istnial, ale server.js/storage.js nigdy go faktycznie nie uzywaly -
        // strona byla martwa, mimo ze wygladala na gotowa).
        this.db.exec(`CREATE TABLE IF NOT EXISTS family_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            address TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            flagged INTEGER NOT NULL DEFAULT 0,
            isLiveError INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL
        )`);

        this.db.exec(`CREATE TABLE IF NOT EXISTS family_strikes (
            address TEXT PRIMARY KEY,
            strikes INTEGER NOT NULL DEFAULT 0
        )`);

        // NAPRAWA (dzisiaj, PILNA): family_messages juz istnial w bazie z
        // INNYM zestawem kolumn (prawdopodobnie porzucona wczesniejsza proba
        // tej samej funkcji, sprzed dzisiejszej sesji - "family" nie
        // wystepowalo NIGDZIE w aktualnym kodzie zrodlowym, ale tabela w
        // .db pliku przetrwala niezaleznie od tego). CREATE TABLE IF NOT
        // EXISTS milczy gdy tabela juz jest, NIEZALEZNIE od tego czy jej
        // kolumny sie zgadzaja - to zablokowalo kazdy cykl payout-watchera,
        // bo Storage() jest tworzone od nowa co 30s przez payout.js. Ten
        // sam wzorzec co mempool/receivedAt wyzej, ale sprawdzam KAZDA z
        // szesciu kolumn osobno, nie zakladam ze tylko jednej brakuje.
        const familyMessagesColumns = this.db
            .prepare("PRAGMA table_info(family_messages)")
            .all();

        const familyMessagesColumnDefs = {
            address: "TEXT NOT NULL DEFAULT ''",
            message: "TEXT NOT NULL DEFAULT ''",
            timestamp: "INTEGER NOT NULL DEFAULT 0",
            flagged: "INTEGER NOT NULL DEFAULT 0",
            isLiveError: "INTEGER NOT NULL DEFAULT 0",
            createdAt: "INTEGER NOT NULL DEFAULT 0"
        };

        for (const [name, def] of Object.entries(familyMessagesColumnDefs)) {
            const hasColumn = familyMessagesColumns.some(
                (column) => column.name === name
            );

            if (!hasColumn) {
                this.db.exec(
                    `ALTER TABLE family_messages ADD COLUMN ${name} ${def}`
                );
            }
        }

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_family_flagged ON family_messages(flagged)"
        );
        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_family_liveerror ON family_messages(isLiveError)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions(blockHeight)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_credits_miner ON pool_credits(minerAddress)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_credits_paid ON pool_credits(paid)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_credits_paid_height ON pool_credits(paid, blockHeight)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_address)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_address)"
        );

        this._insertBlock = this.db.prepare(
            "INSERT INTO blocks (height, timestamp, previousHash, hash, nonce, difficulty) VALUES (?, ?, ?, ?, ?, ?)"
        );

        this._insertTx = this.db.prepare(
            "INSERT INTO transactions (blockHeight, from_address, to_address, amount, type, fee, timestamp, publicKey, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );

        this._insertCredit = this.db.prepare(
            "INSERT INTO pool_credits (minerAddress, blockHeight, shares, amount, timestamp) VALUES (?, ?, ?, ?, ?)"
        );

        this._insertFamilyMessage = this.db.prepare(
            "INSERT INTO family_messages (address, message, timestamp, flagged, isLiveError, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
        );
    }

    hasBlocks() {
        return this.db.prepare(
            "SELECT COUNT(*) AS n FROM blocks"
        ).get().n > 0;
    }

    // Lekkie, celowo bez difficulty/hash/transactions - tylko wysokosci
    // nowszych blokow (indeks na PRIMARY KEY), do naliczania budzetu
    // splaty dlugu legacy (opcja B) bez ladowania calego lancucha co cykl.
    getBlockHeightsSince(afterHeight) {
        return this.db.prepare(
            "SELECT height FROM blocks WHERE height > ? ORDER BY height ASC"
        ).all(afterHeight).map((r) => r.height);
    }

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

        // NAPRAWA (dzisiaj): PRZED - osobne zapytanie SQL per blok
        // (txStmt.all(row.height) wewnątrz .map() nad blockRows) - przy
        // ~94 tys. bloków to ~94 tys. osobnych zapytań SQL, synchronicznie,
        // PRZY KAŻDYM starcie procesu. Potwierdzony w pm2 logs realny
        // powod crashu OOM (526 restartów, uptime~1s w kółko).
        //
        // Pierwsza wersja tej poprawki (jedno "SELECT * FROM
        // transactions" + grupowanie w Map) była szybsza, ale ZMIERZONA
        // jako zużywająca WIĘCEJ szczytowej pamięci niż oryginał - bo
        // trzymała całą tabelę transactions naraz jako płaską tablicę,
        // RÓWNOLEGLE z tworzoną z niej Mapą. Więc: merge-join przez
        // .iterate() - oba zapytania posortowane rosnąco (blocks.height,
        // transactions.blockHeight), czytane strumieniowo w parze,
        // zamiast materializować całą jedną czy drugą tabelę naraz.
        // 2 zapytania total (naprawia N+1/czas), bez skoku pamięci.
        const blockIter =
            this.db.prepare(
                "SELECT * FROM blocks ORDER BY height ASC"
            ).iterate();

        const txIter =
            this.db.prepare(
                "SELECT * FROM transactions ORDER BY blockHeight ASC, id ASC"
            ).iterate();

        let txPeek = txIter.next();

        const chain = [];

        for (const row of blockIter) {

            // Transakcje o blockHeight mniejszym niż bieżący blok nie
            // mogą już dopasować się do żadnego bloku (oba strumienie
            // rosnące) - pomijamy, dokładnie tak samo jak oryginalne
            // "WHERE blockHeight = ?" nigdy by ich nie zwróciło, bo
            // pytało tylko o height realnie istniejących bloków.
            while (
                !txPeek.done &&
                txPeek.value.blockHeight < row.height
            ) {
                txPeek = txIter.next();
            }

            const transactions = [];

            while (
                !txPeek.done &&
                txPeek.value.blockHeight === row.height
            ) {

                const tx = txPeek.value;

                transactions.push({
                    from: tx.from_address,
                    to: tx.to_address,
                    amount: tx.amount,
                    type: tx.type,
                    fee: tx.fee ?? undefined,
                    timestamp: tx.timestamp ?? undefined,
                    publicKey: tx.publicKey ?? undefined,
                    signature: tx.signature ?? undefined
                });

                txPeek = txIter.next();
            }

            chain.push({
                height: row.height,
                timestamp: row.timestamp,
                previousHash: row.previousHash,
                hash: row.hash,
                nonce: row.nonce,
                difficulty: row.difficulty,
                transactions
            });
        }

        return chain;
    }

    loadMempool() {
        return this.db.prepare(
            "SELECT * FROM mempool ORDER BY fee DESC, receivedAt ASC"
        ).all().map((tx) => ({
            from: tx.from_address,
            to: tx.to_address,
            amount: tx.amount,
            fee: tx.fee,
            timestamp: tx.timestamp,
            publicKey: tx.publicKey,
            signature: tx.signature,
            receivedAt: tx.receivedAt
        }));
    }

    saveMempoolTx(tx) {
        this.db.prepare(`
            INSERT OR REPLACE INTO mempool
            (
                signature,
                from_address,
                to_address,
                amount,
                fee,
                timestamp,
                publicKey,
                receivedAt
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            tx.signature,
            tx.from,
            tx.to,
            tx.amount,
            tx.fee,
            tx.timestamp,
            tx.publicKey,
            tx.receivedAt ?? Date.now()
        );
    }

    deleteMempoolTx(signature) {
        this.db.prepare(
            "DELETE FROM mempool WHERE signature = ?"
        ).run(signature);
    }

    saveCredit(c) {
        this._insertCredit.run(
            c.minerAddress,
            c.blockHeight,
            c.shares,
            c.amount,
            c.timestamp
        );
    }

    getKnownPoolMiners() {
        return this.db.prepare(`
            SELECT
                minerAddress,
                SUM(amount) as totalCredits,
                MAX(blockHeight) as lastBlockHeight,
                COUNT(*) as roundsParticipated
            FROM pool_credits
            GROUP BY minerAddress
            ORDER BY lastBlockHeight DESC
        `).all();
    }

    // NAPRAWA (dzisiaj): docs.html dokumentowal /pool/credits/:address jako
    // istniejacy endpoint - server.js nigdy go nie mial, a pool.js's
    // getCredits() wolalo this.blockchain.getCredits(), ktora TEZ nigdy nie
    // istniala (rzucaloby dopiero przy pierwszym realnym uzyciu). Docs byly
    // "uczciwe" tylko z pozoru - opisywaly cos co nigdy nie dzialalo.
    getCreditsForAddress(minerAddress) {
        const paid = this.db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
            FROM pool_credits WHERE minerAddress = ? AND paid = 1
        `).get(minerAddress);

        const unpaid = this.db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
            FROM pool_credits WHERE minerAddress = ? AND paid = 0
        `).get(minerAddress);

        return {
            minerAddress,
            paidTotal: paid.total,
            paidCount: paid.count,
            unpaidTotal: unpaid.total,
            unpaidCount: unpaid.count
        };
    }

    // NAPRAWA (dzisiaj, audyt długu wypłat): stara wersja miała LIMIT 5000 na
    // surowych wierszach PRZED agregacją per-adres, i filtr wykluczający
    // wysokości bloku z >1000 kredytami jako rzekomą "korupcję VARDIFF".
    // Sprawdzone na żywych danych: 49010 niezapłaconych wierszy (>5000 -
    // limit realnie obcinał), a filtr wycinał m.in. blok 100881 (prawdziwy
    // 9-godzinny stój, nie korupcja) i 101508/101710 (prawdziwa praca przy
    // wysokim VARDIFF, matematycznie ograniczona sufitem maxShareValue -
    // zero wierszy w całej tabeli go przekracza, sprawdzone). Stara
    // korupcja (256x nad sufitem) jest w osobnej tabeli
    // pool_credits_corrupted_archive, nie tutaj - ten filtr nie chronił
    // przed niczym co realnie istnieje, tylko fałszywie wycinał prawdziwy
    // dług. Czysty SQL GROUP BY, bez limitu i bez filtra.
    getUnpaidCreditsSummary() {
        const rows = this.db.prepare(`
            SELECT minerAddress, SUM(amount) as total, COUNT(*) as count
            FROM pool_credits
            WHERE paid = 0
            GROUP BY minerAddress
        `).all();

        return rows.map((r) => ({
            minerAddress: r.minerAddress,
            total: r.total,
            count: r.count
        }));
    }

    getUnpaidCreditIdsForAddress(minerAddress) {
        return this.db.prepare(`
            SELECT id FROM pool_credits WHERE minerAddress = ? AND paid = 0
        `).all(minerAddress).map((r) => r.id);
    }

    // NAPRAWA (dzisiaj, strategia długu wypłat, opcja B): dług sprzed
    // wdrożenia (legacy, timestamp < cutoffMs) i dług od tego momentu
    // (current) muszą być rozróżnialne per adres, żeby payout.js mógł
    // spłacać current w całości jak dotychczas, a legacy stopniowo z
    // osobnego budżetu.
    getUnpaidCreditsSummarySplitByCutoff(cutoffMs) {
        const rows = this.db.prepare(`
            SELECT minerAddress,
                COALESCE(SUM(CASE WHEN timestamp < ? THEN amount END), 0) as legacyTotal,
                COALESCE(SUM(CASE WHEN timestamp < ? THEN 1 END), 0) as legacyCount,
                COALESCE(SUM(CASE WHEN timestamp >= ? THEN amount END), 0) as currentTotal,
                COALESCE(SUM(CASE WHEN timestamp >= ? THEN 1 END), 0) as currentCount
            FROM pool_credits
            WHERE paid = 0
            GROUP BY minerAddress
        `).all(cutoffMs, cutoffMs, cutoffMs, cutoffMs);

        return rows.map((r) => ({
            minerAddress: r.minerAddress,
            legacyTotal: r.legacyTotal,
            legacyCount: r.legacyCount,
            currentTotal: r.currentTotal,
            currentCount: r.currentCount
        }));
    }

    getUnpaidCreditIdsForAddressSince(minerAddress, cutoffMs) {
        return this.db.prepare(`
            SELECT id FROM pool_credits
            WHERE minerAddress = ? AND paid = 0 AND timestamp >= ?
        `).all(minerAddress, cutoffMs).map((r) => r.id);
    }

    // Najstarsze niezapłacone kredyty LEGACY (timestamp < cutoffMs) dla
    // adresu, kumulowane od najstarszego (id ASC) aż do maxAmount - do
    // częściowej spłaty starego długu z ograniczonego budżetu. Jeśli nawet
    // najstarszy wiersz przekracza maxAmount, zwraca pusty wynik (czeka na
    // kolejny cykl akumulacji) zamiast wymuszać wysyłkę ponad budżet -
    // budżet nigdy nie schodzi poniżej zera, postęp jest przewidywalny.
    getUnpaidLegacyCreditIdsUpToAmount(minerAddress, cutoffMs, maxAmount) {
        const rows = this.db.prepare(`
            SELECT id, amount FROM pool_credits
            WHERE minerAddress = ? AND paid = 0 AND timestamp < ?
            ORDER BY id ASC
        `).all(minerAddress, cutoffMs);

        const creditIds = [];
        let amount = 0;
        for (const row of rows) {
            if (amount + row.amount > maxAmount) break;
            creditIds.push(row.id);
            amount += row.amount;
        }
        return { creditIds, amount };
    }

    markCreditsPaid(creditIds) {
        const stmt = this.db.prepare(
            "UPDATE pool_credits SET paid = 1 WHERE id = ?"
        );

        for (const id of creditIds) {
            stmt.run(id);
        }
    }

    // --- "Rodzina BbC" ---

    saveFamilyMessage(record) {
        this._insertFamilyMessage.run(
            record.address,
            record.message,
            record.timestamp,
            record.flagged ? 1 : 0,
            record.isLiveError ? 1 : 0,
            Date.now()
        );
    }

    getFamilyMessages(limit = 50) {
        return this.db.prepare(
            "SELECT * FROM family_messages WHERE flagged = 0 ORDER BY timestamp ASC LIMIT ?"
        ).all(limit);
    }

    getFamilyLiveErrors(limit = 20) {
        return this.db.prepare(
            "SELECT * FROM family_messages WHERE isLiveError = 1 ORDER BY timestamp DESC LIMIT ?"
        ).all(limit);
    }

    getFamilyPending(limit = 50) {
        return this.db.prepare(
            "SELECT * FROM family_messages WHERE flagged = 1 ORDER BY timestamp ASC LIMIT ?"
        ).all(limit);
    }

    getFamilyMessageById(id) {
        return this.db.prepare(
            "SELECT * FROM family_messages WHERE id = ?"
        ).get(id) || null;
    }

    setFamilyMessageFlag(id, flagged) {
        this.db.prepare(
            "UPDATE family_messages SET flagged = ? WHERE id = ?"
        ).run(flagged ? 1 : 0, id);
    }

    deleteFamilyMessage(id) {
        this.db.prepare(
            "DELETE FROM family_messages WHERE id = ?"
        ).run(id);
    }

    getFamilyStrikes(address) {
        const row = this.db.prepare(
            "SELECT strikes FROM family_strikes WHERE address = ?"
        ).get(address);
        return row ? row.strikes : 0;
    }

    addFamilyStrike(address) {
        const current = this.getFamilyStrikes(address);
        const next = current + 1;
        this.db.prepare(
            "INSERT INTO family_strikes (address, strikes) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET strikes = ?"
        ).run(address, next, next);
        return next;
    }

    _addressEventsCTE() {
        return `
            WITH address_events AS (
                SELECT
                    t.to_address AS address,
                    COALESCE(t.timestamp, b.timestamp) AS ts
                FROM transactions t
                JOIN blocks b ON t.blockHeight = b.height
                WHERE t.to_address IS NOT NULL

                UNION ALL

                SELECT
                    t.from_address AS address,
                    COALESCE(t.timestamp, b.timestamp) AS ts
                FROM transactions t
                JOIN blocks b ON t.blockHeight = b.height
                WHERE t.from_address IS NOT NULL
            )
        `;
    }

    getNewAddressesPerDay(days = 30) {
        const sinceMs =
            Date.now() - days * 24 * 60 * 60 * 1000;

        return this.db.prepare(`
            ${this._addressEventsCTE()},
            first_seen AS (
                SELECT address, MIN(ts) AS first_ts
                FROM address_events
                GROUP BY address
            )
            SELECT
                date(first_ts / 1000, 'unixepoch') AS day,
                COUNT(*) AS newAddresses
            FROM first_seen
            WHERE first_ts >= ?
            GROUP BY day
            ORDER BY day DESC
        `).all(sinceMs);
    }

    getActiveAddresses24h(topLimit = 5) {
        const sinceMs =
            Date.now() - 24 * 60 * 60 * 1000;

        const rows = this.db.prepare(`
            ${this._addressEventsCTE()}
            SELECT
                address,
                COUNT(*) AS events,
                MAX(ts) AS lastActive
            FROM address_events
            WHERE ts >= ?
            GROUP BY address
            ORDER BY events DESC
        `).all(sinceMs);

        return {
            totalActive: rows.length,
            top: rows.slice(0, topLimit)
        };
    }

    close() {
        this.db.close();
    }
}

module.exports = Storage;
