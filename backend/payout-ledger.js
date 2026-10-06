"use strict";

class PayoutLedger {
    constructor(storage) {
        if (!storage || !storage.db) {
            throw new Error("PayoutLedger wymaga Storage z aktywna baza");
        }

        this.storage = storage;
        this.db = storage.db;

        this._initSchema();
    }

    _initSchema() {
        const creditColumns = this.db
            .prepare("PRAGMA table_info(pool_credits)")
            .all();

        const hasBatchColumn = creditColumns.some(
            (column) => column.name === "payoutBatchId"
        );

        if (!hasBatchColumn) {
            try {
                this.db.exec(
                    "ALTER TABLE pool_credits ADD COLUMN payoutBatchId TEXT"
                );
            } catch (err) {
                /*
                 * Dwa procesy payout moga wystartowac jednoczesnie:
                 *
                 * A: PRAGMA -> brak kolumny
                 * B: PRAGMA -> brak kolumny
                 * A: ALTER -> sukces
                 * B: ALTER -> "duplicate column name"
                 *
                 * To jest bezpieczny race migracji schematu, nie awaria.
                 * Ignorujemy WYLACZNIE duplicate-column i po nim
                 * ponownie sprawdzamy rzeczywisty schemat.
                 */
                const message =
                    String(
                        err &&
                        err.message
                    );

                if (
                    !/duplicate column name/i.test(
                        message
                    )
                ) {
                    throw err;
                }

                const afterRace =
                    this.db
                        .prepare(
                            "PRAGMA table_info(pool_credits)"
                        )
                        .all();

                const reallyExists =
                    afterRace.some(
                        (column) =>
                            column.name ===
                            "payoutBatchId"
                    );

                if (!reallyExists) {
                    throw err;
                }
            }
        }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS payout_batches (
                batchId TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                minerAddress TEXT NOT NULL,
                fromAddress TEXT NOT NULL,
                amount REAL NOT NULL,
                fee REAL NOT NULL,
                txTimestamp INTEGER NOT NULL,
                candidateJson TEXT,
                txSignature TEXT,
                state TEXT NOT NULL,
                reason TEXT,
                createdAt INTEGER NOT NULL,
                submittedAt INTEGER,
                confirmedAt INTEGER,
                wasFirstPayout INTEGER,
                referralProcessed INTEGER NOT NULL DEFAULT 0
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS payout_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                cutoffTimestamp INTEGER NOT NULL,
                lastCheckedHeight INTEGER NOT NULL,
                accruedBudget REAL NOT NULL
            )
        `);

        this.db.exec(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_signature ON payout_batches(txSignature)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_payout_state ON payout_batches(state)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_payout_miner_state ON payout_batches(minerAddress, state)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_credits_payout_batch ON pool_credits(payoutBatchId)"
        );

        this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_tx_signature ON transactions(signature)"
        );
    }

    _transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");

        try {
            const result = fn();

            this.db.exec("COMMIT");

            return result;
        } catch (err) {
            try {
                this.db.exec("ROLLBACK");
            } catch {}

            throw err;
        }
    }

    _assertMoney(value, name) {
        if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0
        ) {
            throw new Error(
                `${name} musi byc skonczona liczba >= 0`
            );
        }
    }

    _sameMoney(a, b) {
        const scale = Math.max(
            1,
            Math.abs(a),
            Math.abs(b)
        );

        return Math.abs(a - b) <= 1e-9 * scale;
    }

    ensureState(seed) {
        if (
            !seed ||
            !Number.isFinite(seed.cutoffTimestamp) ||
            !Number.isInteger(seed.lastCheckedHeight)
        ) {
            throw new Error("Nieprawidlowy seed payout_state");
        }

        this._assertMoney(
            seed.accruedBudget,
            "accruedBudget"
        );

        return this._transaction(() => {
            this.db.prepare(`
                INSERT OR IGNORE INTO payout_state
                (
                    singleton,
                    cutoffTimestamp,
                    lastCheckedHeight,
                    accruedBudget
                )
                VALUES (1, ?, ?, ?)
            `).run(
                seed.cutoffTimestamp,
                seed.lastCheckedHeight,
                seed.accruedBudget
            );

            return this.getState();
        });
    }

    getState() {
        return this.db.prepare(`
            SELECT
                cutoffTimestamp,
                lastCheckedHeight,
                accruedBudget
            FROM payout_state
            WHERE singleton = 1
        `).get() || null;
    }

    advanceLegacyBudget(
        expectedLastHeight,
        newLastHeight,
        addedBudget
    ) {
        if (
            !Number.isInteger(expectedLastHeight) ||
            !Number.isInteger(newLastHeight) ||
            newLastHeight < expectedLastHeight
        ) {
            throw new Error("Nieprawidlowe wysokosci payout_state");
        }

        this._assertMoney(
            addedBudget,
            "addedBudget"
        );

        return this._transaction(() => {
            const result = this.db.prepare(`
                UPDATE payout_state
                SET
                    lastCheckedHeight = ?,
                    accruedBudget = accruedBudget + ?
                WHERE
                    singleton = 1
                    AND lastCheckedHeight = ?
            `).run(
                newLastHeight,
                addedBudget,
                expectedLastHeight
            );

            return {
                advanced:
                    Number(result.changes) === 1,
                state:
                    this.getState()
            };
        });
    }

    getAvailableSummary(cutoffMs) {
        const rows = this.db.prepare(`
            SELECT
                minerAddress,
                COALESCE(
                    SUM(
                        CASE
                            WHEN timestamp < ?
                            THEN amount
                        END
                    ),
                    0
                ) AS legacyTotal,
                COALESCE(
                    SUM(
                        CASE
                            WHEN timestamp < ?
                            THEN 1
                        END
                    ),
                    0
                ) AS legacyCount,
                COALESCE(
                    SUM(
                        CASE
                            WHEN timestamp >= ?
                            THEN amount
                        END
                    ),
                    0
                ) AS currentTotal,
                COALESCE(
                    SUM(
                        CASE
                            WHEN timestamp >= ?
                            THEN 1
                        END
                    ),
                    0
                ) AS currentCount
            FROM pool_credits
            WHERE
                paid = 0
                AND payoutBatchId IS NULL
            GROUP BY minerAddress
        `).all(
            cutoffMs,
            cutoffMs,
            cutoffMs,
            cutoffMs
        );

        return rows;
    }

    _hasActiveMinerBatch(minerAddress) {
        return !!this.db.prepare(`
            SELECT 1
            FROM payout_batches
            WHERE
                minerAddress = ?
                AND state IN ('reserved', 'submitted')
            LIMIT 1
        `).get(minerAddress);
    }

    _hasActiveLegacyBatch() {
        return !!this.db.prepare(`
            SELECT 1
            FROM payout_batches
            WHERE
                kind = 'legacy'
                AND state IN ('reserved', 'submitted')
            LIMIT 1
        `).get();
    }

    _reserveRows({
        batchId,
        kind,
        minerAddress,
        fromAddress,
        rows,
        amount,
        fee,
        txTimestamp
    }) {
        this.db.prepare(`
            INSERT INTO payout_batches
            (
                batchId,
                kind,
                minerAddress,
                fromAddress,
                amount,
                fee,
                txTimestamp,
                state,
                createdAt
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
        `).run(
            batchId,
            kind,
            minerAddress,
            fromAddress,
            amount,
            fee,
            txTimestamp,
            Date.now()
        );

        const reserve = this.db.prepare(`
            UPDATE pool_credits
            SET payoutBatchId = ?
            WHERE
                id = ?
                AND paid = 0
                AND payoutBatchId IS NULL
        `);

        for (const row of rows) {
            const result = reserve.run(
                batchId,
                row.id
            );

            if (Number(result.changes) !== 1) {
                throw new Error(
                    `Credit ${row.id} zostal zajety rownolegle`
                );
            }
        }

        return this.getBatch(batchId);
    }

    reserveCurrent({
        batchId,
        minerAddress,
        fromAddress,
        cutoffMs,
        minPayout,
        fee,
        txTimestamp
    }) {
        this._assertMoney(
            minPayout,
            "minPayout"
        );

        this._assertMoney(
            fee,
            "fee"
        );

        return this._transaction(() => {
            if (
                this._hasActiveMinerBatch(
                    minerAddress
                )
            ) {
                return null;
            }

            const rows = this.db.prepare(`
                SELECT id, amount
                FROM pool_credits
                WHERE
                    minerAddress = ?
                    AND paid = 0
                    AND payoutBatchId IS NULL
                    AND timestamp >= ?
                ORDER BY id ASC
            `).all(
                minerAddress,
                cutoffMs
            );

            const amount = rows.reduce(
                (sum, row) =>
                    sum + Number(row.amount),
                0
            );

            if (
                rows.length === 0 ||
                amount < minPayout
            ) {
                return null;
            }

            return this._reserveRows({
                batchId,
                kind: "current",
                minerAddress,
                fromAddress,
                rows,
                amount,
                fee,
                txTimestamp
            });
        });
    }

    reserveLegacy({
        batchId,
        minerAddress,
        fromAddress,
        cutoffMs,
        maxAmount,
        fee,
        txTimestamp
    }) {
        this._assertMoney(
            maxAmount,
            "maxAmount"
        );

        this._assertMoney(
            fee,
            "fee"
        );

        return this._transaction(() => {
            if (
                this._hasActiveMinerBatch(
                    minerAddress
                ) ||
                this._hasActiveLegacyBatch()
            ) {
                return null;
            }

            const state = this.getState();

            if (!state) {
                throw new Error(
                    "Brak payout_state"
                );
            }

            const available = Math.min(
                Number(state.accruedBudget),
                maxAmount
            );

            if (!(available > 0)) {
                return null;
            }

            const sourceRows =
                this.db.prepare(`
                    SELECT id, amount
                    FROM pool_credits
                    WHERE
                        minerAddress = ?
                        AND paid = 0
                        AND payoutBatchId IS NULL
                        AND timestamp < ?
                    ORDER BY id ASC
                `).all(
                    minerAddress,
                    cutoffMs
                );

            const rows = [];
            let amount = 0;

            for (const row of sourceRows) {
                const next =
                    amount +
                    Number(row.amount);

                if (next > available) {
                    break;
                }

                rows.push(row);
                amount = next;
            }

            if (rows.length === 0) {
                return null;
            }

            return this._reserveRows({
                batchId,
                kind: "legacy",
                minerAddress,
                fromAddress,
                rows,
                amount,
                fee,
                txTimestamp
            });
        });
    }

    getBatch(batchId) {
        const row = this.db.prepare(`
            SELECT *
            FROM payout_batches
            WHERE batchId = ?
        `).get(batchId);

        if (!row) {
            return null;
        }

        const creditIds = this.db.prepare(`
            SELECT id
            FROM pool_credits
            WHERE payoutBatchId = ?
            ORDER BY id ASC
        `).all(batchId).map(
            (credit) => credit.id
        );

        return {
            ...row,
            candidate:
                row.candidateJson
                    ? JSON.parse(
                        row.candidateJson
                    )
                    : null,
            creditIds
        };
    }

    getActiveBatches() {
        return this.db.prepare(`
            SELECT batchId
            FROM payout_batches
            WHERE state IN ('reserved', 'submitted')
            ORDER BY createdAt ASC, batchId ASC
        `).all().map(
            (row) =>
                this.getBatch(
                    row.batchId
                )
        );
    }

    attachCandidate(
        batchId,
        candidate
    ) {
        if (
            !candidate ||
            typeof candidate.signature !== "string" ||
            candidate.signature.length === 0
        ) {
            throw new Error(
                "Nieprawidlowy kandydat payout"
            );
        }

        return this._transaction(() => {
            const batch =
                this.getBatch(batchId);

            if (!batch) {
                throw new Error(
                    "Nieznany payout batch"
                );
            }

            if (
                batch.state === "confirmed" ||
                batch.state === "failed"
            ) {
                throw new Error(
                    `Batch jest juz ${batch.state}`
                );
            }

            if (
                candidate.from !==
                    batch.fromAddress ||
                candidate.to !==
                    batch.minerAddress ||
                !this._sameMoney(
                    Number(candidate.amount),
                    Number(batch.amount)
                ) ||
                !this._sameMoney(
                    Number(candidate.fee),
                    Number(batch.fee)
                ) ||
                candidate.timestamp !==
                    batch.txTimestamp
            ) {
                throw new Error(
                    "Kandydat nie odpowiada zarezerwowanemu batchowi"
                );
            }

            if (
                batch.txSignature &&
                batch.txSignature !==
                    candidate.signature
            ) {
                throw new Error(
                    "Batch ma juz inny podpis"
                );
            }

            this.db.prepare(`
                UPDATE payout_batches
                SET
                    candidateJson = ?,
                    txSignature = ?
                WHERE batchId = ?
            `).run(
                JSON.stringify(candidate),
                candidate.signature,
                batchId
            );

            return this.getBatch(batchId);
        });
    }

    markSubmitted(batchId) {
        return this._transaction(() => {
            const batch =
                this.getBatch(batchId);

            if (!batch) {
                throw new Error(
                    "Nieznany payout batch"
                );
            }

            if (
                batch.state === "confirmed"
            ) {
                return batch;
            }

            if (
                batch.state === "failed"
            ) {
                throw new Error(
                    "Nie mozna wyslac failed batch"
                );
            }

            if (!batch.txSignature) {
                throw new Error(
                    "Batch nie ma jeszcze podpisanej transakcji"
                );
            }

            this.db.prepare(`
                UPDATE payout_batches
                SET
                    state = 'submitted',
                    submittedAt = COALESCE(
                        submittedAt,
                        ?
                    )
                WHERE batchId = ?
            `).run(
                Date.now(),
                batchId
            );

            return this.getBatch(batchId);
        });
    }

    getEvidence(signature) {
        if (!signature) {
            return {
                pending: false,
                confirmed: false
            };
        }

        const pending =
            !!this.db.prepare(`
                SELECT 1
                FROM mempool
                WHERE signature = ?
                LIMIT 1
            `).get(signature);

        const confirmed =
            !!this.db.prepare(`
                SELECT 1
                FROM transactions
                WHERE signature = ?
                LIMIT 1
            `).get(signature);

        return {
            pending,
            confirmed
        };
    }

    finalize(batchId) {
        return this._transaction(() => {
            const batch =
                this.getBatch(batchId);

            if (!batch) {
                throw new Error(
                    "Nieznany payout batch"
                );
            }

            if (batch.state === "confirmed") {
                return batch;
            }

            if (batch.state === "failed") {
                throw new Error(
                    "Nie mozna finalizowac failed batch"
                );
            }

            if (!batch.txSignature) {
                throw new Error(
                    "Batch bez podpisanej transakcji"
                );
            }

            const evidence =
                this.getEvidence(
                    batch.txSignature
                );

            if (!evidence.confirmed) {
                throw new Error(
                    "Payout nie jest jeszcze potwierdzony w lancuchu"
                );
            }

            const rows = this.db.prepare(`
                SELECT id, amount
                FROM pool_credits
                WHERE
                    payoutBatchId = ?
                    AND paid = 0
                ORDER BY id ASC
            `).all(batchId);

            const reservedAmount =
                rows.reduce(
                    (sum, row) =>
                        sum +
                        Number(row.amount),
                    0
                );

            if (
                rows.length === 0 ||
                !this._sameMoney(
                    reservedAmount,
                    Number(batch.amount)
                )
            ) {
                throw new Error(
                    "Zarezerwowane kredyty nie zgadzaja sie z kwota batcha"
                );
            }

            const previousPaid =
                this.db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM pool_credits
                    WHERE
                        minerAddress = ?
                        AND paid = 1
                `).get(
                    batch.minerAddress
                );

            if (batch.kind === "legacy") {
                const state =
                    this.getState();

                if (!state) {
                    throw new Error(
                        "Brak payout_state"
                    );
                }

                if (
                    Number(state.accruedBudget) +
                        1e-9 <
                    Number(batch.amount)
                ) {
                    throw new Error(
                        "Budzet legacy jest mniejszy niz finalizowany batch"
                    );
                }

                this.db.prepare(`
                    UPDATE payout_state
                    SET accruedBudget =
                        accruedBudget - ?
                    WHERE singleton = 1
                `).run(
                    batch.amount
                );
            }

            this.db.prepare(`
                UPDATE pool_credits
                SET paid = 1
                WHERE
                    payoutBatchId = ?
                    AND paid = 0
            `).run(batchId);

            this.db.prepare(`
                UPDATE payout_batches
                SET
                    state = 'confirmed',
                    confirmedAt = ?,
                    wasFirstPayout = ?
                WHERE batchId = ?
            `).run(
                Date.now(),
                Number(previousPaid.count) === 0
                    ? 1
                    : 0,
                batchId
            );

            return this.getBatch(batchId);
        });
    }

    fail(
        batchId,
        reason
    ) {
        return this._transaction(() => {
            const batch =
                this.getBatch(batchId);

            if (!batch) {
                throw new Error(
                    "Nieznany payout batch"
                );
            }

            if (batch.state === "confirmed") {
                throw new Error(
                    "Nie mozna anulowac potwierdzonego batcha"
                );
            }

            if (batch.state === "submitted") {
                throw new Error(
                    "Nie mozna zwolnic submitted batch bez rozstrzygniecia transakcji"
                );
            }

            this.db.prepare(`
                UPDATE pool_credits
                SET payoutBatchId = NULL
                WHERE
                    payoutBatchId = ?
                    AND paid = 0
            `).run(batchId);

            this.db.prepare(`
                UPDATE payout_batches
                SET
                    state = 'failed',
                    reason = ?
                WHERE batchId = ?
            `).run(
                String(reason || "unknown"),
                batchId
            );

            return this.getBatch(batchId);
        });
    }

    rejectSubmitted(
        batchId,
        reason
    ) {
        return this._transaction(() => {
            const batch =
                this.getBatch(batchId);

            if (!batch) {
                throw new Error(
                    "Nieznany payout batch"
                );
            }

            if (batch.state !== "submitted") {
                throw new Error(
                    "Tylko submitted batch moze byc odrzucony ta sciezka"
                );
            }

            if (!batch.txSignature) {
                throw new Error(
                    "Submitted batch bez podpisu"
                );
            }

            const evidence =
                this.getEvidence(
                    batch.txSignature
                );

            if (
                evidence.pending ||
                evidence.confirmed
            ) {
                throw new Error(
                    "Nie mozna zwolnic batcha z dowodem transakcji"
                );
            }

            this.db.prepare(`
                UPDATE pool_credits
                SET payoutBatchId = NULL
                WHERE
                    payoutBatchId = ?
                    AND paid = 0
            `).run(batchId);

            this.db.prepare(`
                UPDATE payout_batches
                SET
                    state = 'failed',
                    reason = ?
                WHERE batchId = ?
            `).run(
                String(
                    reason ||
                    "definitive-rejection"
                ),
                batchId
            );

            return this.getBatch(
                batchId
            );
        });
    }

    getReferralPending() {
        return this.db.prepare(`
            SELECT batchId
            FROM payout_batches
            WHERE
                state = 'confirmed'
                AND wasFirstPayout = 1
                AND referralProcessed = 0
            ORDER BY confirmedAt ASC
        `).all().map(
            (row) =>
                this.getBatch(
                    row.batchId
                )
        );
    }

    markReferralProcessed(batchId) {
        this.db.prepare(`
            UPDATE payout_batches
            SET referralProcessed = 1
            WHERE
                batchId = ?
                AND state = 'confirmed'
        `).run(batchId);
    }
}

module.exports = PayoutLedger;
