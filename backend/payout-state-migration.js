"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PayoutLedger =
    require("./payout-ledger");

const MIGRATION_ID =
    "legacy-debt-json-v1";

class PayoutStateMigration {
    constructor(
        storage,
        {
            statePath,
            now = () => Date.now()
        } = {}
    ) {
        if (!storage || !storage.db) {
            throw new Error(
                "PayoutStateMigration wymaga Storage"
            );
        }

        if (
            typeof statePath !== "string" ||
            statePath.length === 0
        ) {
            throw new Error(
                "Brak statePath"
            );
        }

        if (typeof now !== "function") {
            throw new Error(
                "now musi byc funkcja"
            );
        }

        this.storage = storage;
        this.db = storage.db;
        this.statePath =
            path.resolve(statePath);
        this.now = now;

        this.ledger =
            new PayoutLedger(
                storage
            );

        this._initSchema();
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS payout_state_migrations (
                migrationId TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                sourcePath TEXT,
                sourceHash TEXT,
                cutoffTimestamp INTEGER NOT NULL,
                lastCheckedHeight INTEGER NOT NULL,
                accruedBudget REAL NOT NULL,
                migratedAt INTEGER NOT NULL
            )
        `);
    }

    _getMigration() {
        return (
            this.db.prepare(`
                SELECT *
                FROM payout_state_migrations
                WHERE migrationId = ?
            `).get(
                MIGRATION_ID
            ) || null
        );
    }

    _validateState(value) {
        if (
            !value ||
            typeof value !== "object"
        ) {
            throw new Error(
                "Nieprawidlowy legacy payout state"
            );
        }

        const cutoffTimestamp =
            Number(
                value.cutoffTimestamp
            );

        const lastCheckedHeight =
            Number(
                value.lastCheckedHeight
            );

        const accruedBudget =
            Number(
                value.accruedBudget
            );

        if (
            !Number.isInteger(
                cutoffTimestamp
            ) ||
            cutoffTimestamp <= 0
        ) {
            throw new Error(
                "Nieprawidlowy cutoffTimestamp"
            );
        }

        if (
            !Number.isInteger(
                lastCheckedHeight
            ) ||
            lastCheckedHeight < -1
        ) {
            throw new Error(
                "Nieprawidlowy lastCheckedHeight"
            );
        }

        if (
            !Number.isFinite(
                accruedBudget
            ) ||
            accruedBudget < 0
        ) {
            throw new Error(
                "Nieprawidlowy accruedBudget"
            );
        }

        return {
            cutoffTimestamp,
            lastCheckedHeight,
            accruedBudget
        };
    }

    _readLegacyFile() {
        const raw =
            fs.readFileSync(
                this.statePath,
                "utf8"
            );

        let parsed;

        try {
            parsed =
                JSON.parse(raw);
        } catch (err) {
            throw new Error(
                "Nieprawidlowy JSON legacy payout state: " +
                err.message
            );
        }

        return {
            raw,
            state:
                this._validateState(
                    parsed
                ),
            hash:
                crypto
                    .createHash(
                        "sha256"
                    )
                    .update(
                        raw,
                        "utf8"
                    )
                    .digest(
                        "hex"
                    )
        };
    }

    _sameState(a, b) {
        return (
            Number(
                a.cutoffTimestamp
            ) ===
                Number(
                    b.cutoffTimestamp
                ) &&
            Number(
                a.lastCheckedHeight
            ) ===
                Number(
                    b.lastCheckedHeight
                ) &&
            Math.abs(
                Number(
                    a.accruedBudget
                ) -
                Number(
                    b.accruedBudget
                )
            ) <= 1e-9
        );
    }

    _transaction(fn) {
        this.db.exec(
            "BEGIN IMMEDIATE"
        );

        try {
            const result = fn();

            this.db.exec(
                "COMMIT"
            );

            return result;
        } catch (err) {
            try {
                this.db.exec(
                    "ROLLBACK"
                );
            } catch {}

            throw err;
        }
    }

    _insertMarker({
        source,
        sourceHash,
        state
    }) {
        this.db.prepare(`
            INSERT INTO payout_state_migrations
            (
                migrationId,
                source,
                sourcePath,
                sourceHash,
                cutoffTimestamp,
                lastCheckedHeight,
                accruedBudget,
                migratedAt
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            MIGRATION_ID,
            source,
            this.statePath,
            sourceHash || null,
            state.cutoffTimestamp,
            state.lastCheckedHeight,
            state.accruedBudget,
            this.now()
        );
    }

    _seedStateAndMarker({
        state,
        source,
        sourceHash
    }) {
        return this._transaction(() => {
            const existing =
                this.ledger
                    .getState();

            if (existing) {
                throw new Error(
                    "payout_state juz istnieje"
                );
            }

            this.db.prepare(`
                INSERT INTO payout_state
                (
                    singleton,
                    cutoffTimestamp,
                    lastCheckedHeight,
                    accruedBudget
                )
                VALUES (1, ?, ?, ?)
            `).run(
                state.cutoffTimestamp,
                state.lastCheckedHeight,
                state.accruedBudget
            );

            this._insertMarker({
                source,
                sourceHash,
                state
            });

            return this.ledger
                .getState();
        });
    }

    migrate() {
        const marker =
            this._getMigration();

        const existing =
            this.ledger
                .getState();

        /*
         * Normalna sciezka po udanej migracji.
         *
         * Stary JSON moze byc pozniej nieaktualny, bo SQLite
         * jest juz jedynym aktywnym stanem. Nie wolno wtedy
         * ponownie nadpisac DB danymi z pliku.
         */
        if (marker) {
            if (!existing) {
                throw new Error(
                    "Marker migracji istnieje, ale brak payout_state"
                );
            }

            return {
                migrated: false,
                source:
                    "database",
                state:
                    existing,
                migration:
                    marker
            };
        }

        const legacyExists =
            fs.existsSync(
                this.statePath
            );

        /*
         * Recovery po bardzo waskim przypadku:
         * stan DB istnieje, ale marker nie zostal zapisany.
         *
         * Akceptujemy to TYLKO jezeli dane sa identyczne z
         * legacy JSON. Przy jakiejkolwiek roznicy zatrzymujemy
         * proces zamiast zgadywac.
         */
        if (existing) {
            if (!legacyExists) {
                throw new Error(
                    "KONFLIKT: payout_state istnieje bez markera migracji i brak legacy JSON"
                );
            }

            const legacy =
                this._readLegacyFile();

            if (
                !this._sameState(
                    existing,
                    legacy.state
                )
            ) {
                throw new Error(
                    "KONFLIKT: payout_state rozni sie od legacy JSON"
                );
            }

            this._transaction(() => {
                this._insertMarker({
                    source:
                        "legacy-json-recovered",
                    sourceHash:
                        legacy.hash,
                    state:
                        existing
                });
            });

            return {
                migrated: true,
                recoveredMarker:
                    true,
                source:
                    "legacy-json-recovered",
                state:
                    this.ledger
                        .getState(),
                migration:
                    this._getMigration()
            };
        }

        /*
         * Normalna migracja istniejacej instalacji.
         */
        if (legacyExists) {
            const legacy =
                this._readLegacyFile();

            const state =
                this._seedStateAndMarker({
                    state:
                        legacy.state,
                    source:
                        "legacy-json",
                    sourceHash:
                        legacy.hash
                });

            return {
                migrated: true,
                recoveredMarker:
                    false,
                source:
                    "legacy-json",
                state,
                migration:
                    this._getMigration()
            };
        }

        /*
         * Brak JSON + brak payout_state.
         *
         * Jezeli istnieja jakiekolwiek kredyty, NIE MOZEMY
         * zgadnac starego cutoffTimestamp. Zatrzymujemy sie.
         */
        const credits =
            Number(
                this.db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM pool_credits
                `).get().count
            );

        if (credits > 0) {
            throw new Error(
                "STOP: brak legacy payout state przy istniejacych pool_credits"
            );
        }

        /*
         * Prawdziwie nowa, pusta instalacja.
         *
         * Dopiero tutaj wolno utworzyc nowy cutoff.
         */
        const heights =
            this.storage
                .getBlockHeightsSince(
                    -1
                );

        const currentTip =
            heights.length > 0
                ? Number(
                    heights[
                        heights.length -
                        1
                    ]
                )
                : -1;

        const freshState = {
            cutoffTimestamp:
                Number(
                    this.now()
                ),
            lastCheckedHeight:
                currentTip,
            accruedBudget:
                0
        };

        this._validateState(
            freshState
        );

        const state =
            this._seedStateAndMarker({
                state:
                    freshState,
                source:
                    "fresh-empty",
                sourceHash:
                    null
            });

        return {
            migrated: true,
            fresh: true,
            source:
                "fresh-empty",
            state,
            migration:
                this._getMigration()
        };
    }
}

module.exports = {
    PayoutStateMigration,
    MIGRATION_ID
};
