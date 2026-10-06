"use strict";

const assert =
    require("assert");

const fs =
    require("fs");

const os =
    require("os");

const path =
    require("path");

const Storage =
    require("./storage");

const PayoutLedger =
    require("./payout-ledger");

const {
    PayoutStateMigration
} = require(
    "./payout-state-migration"
);

let sequence = 0;

function nextPaths(name) {
    sequence++;

    const base =
        path.join(
            os.tmpdir(),
            "bbc-payout-migration-" +
                process.pid +
                "-" +
                Date.now() +
                "-" +
                sequence +
                "-" +
                name
        );

    return {
        db:
            base + ".db",
        json:
            base + ".json"
    };
}

function cleanup(paths) {
    for (
        const file of [
            paths.db,
            paths.db + "-wal",
            paths.db + "-shm",
            paths.json
        ]
    ) {
        try {
            fs.unlinkSync(
                file
            );
        } catch {}
    }
}

function pass(name) {
    console.log(
        "PASS " + name
    );
}

function runCase(
    name,
    fn
) {
    const paths =
        nextPaths(name);

    let storage = null;

    try {
        storage =
            new Storage(
                paths.db
            );

        fn(
            storage,
            paths
        );
    } finally {
        if (storage) {
            try {
                storage.close();
            } catch {}
        }

        cleanup(paths);
    }
}


runCase(
    "exact",
    (storage, paths) => {
        const legacy = {
            cutoffTimestamp:
                1710000000123,
            lastCheckedHeight:
                12345,
            accruedBudget:
                456.789
        };

        const raw =
            JSON.stringify(
                legacy,
                null,
                2
            );

        fs.writeFileSync(
            paths.json,
            raw,
            "utf8"
        );

        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json,
                    now:
                        () =>
                            1800000000000
                }
            );

        const result =
            migration.migrate();

        assert.equal(
            result.migrated,
            true
        );

        assert.equal(
            result.source,
            "legacy-json"
        );

        assert.deepEqual(
            result.state,
            legacy
        );

        assert.equal(
            fs.readFileSync(
                paths.json,
                "utf8"
            ),
            raw
        );

        assert.equal(
            result.migration
                .cutoffTimestamp,
            legacy.cutoffTimestamp
        );

        assert.equal(
            result.migration
                .lastCheckedHeight,
            legacy.lastCheckedHeight
        );

        assert.equal(
            Number(
                result.migration
                    .accruedBudget
            ),
            legacy.accruedBudget
        );

        pass(
            "EXACT_LEGACY_STATE_MIGRATED"
        );
    }
);


runCase(
    "db-wins",
    (storage, paths) => {
        const legacy = {
            cutoffTimestamp:
                1710000000123,
            lastCheckedHeight:
                100,
            accruedBudget:
                25.5
        };

        fs.writeFileSync(
            paths.json,
            JSON.stringify(
                legacy
            ),
            "utf8"
        );

        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json,
                    now:
                        () =>
                            1800000000000
                }
            );

        migration.migrate();

        const ledger =
            new PayoutLedger(
                storage
            );

        const advanced =
            ledger
                .advanceLegacyBudget(
                    100,
                    101,
                    7.25
                );

        assert.equal(
            advanced.advanced,
            true
        );

        /*
         * JSON nadal ma stary height=100/budget=25.5.
         * Drugie migrate NIE MOZE zresetowac bazy.
         */
        const second =
            migration.migrate();

        assert.equal(
            second.migrated,
            false
        );

        assert.equal(
            second.source,
            "database"
        );

        assert.equal(
            second.state
                .lastCheckedHeight,
            101
        );

        assert.equal(
            Number(
                second.state
                    .accruedBudget
            ),
            32.75
        );

        pass(
            "DATABASE_STATE_WINS_AFTER_MIGRATION"
        );
    }
);


runCase(
    "marker-recovery",
    (storage, paths) => {
        const legacy = {
            cutoffTimestamp:
                1711111111111,
            lastCheckedHeight:
                222,
            accruedBudget:
                12.5
        };

        fs.writeFileSync(
            paths.json,
            JSON.stringify(
                legacy
            ),
            "utf8"
        );

        const ledger =
            new PayoutLedger(
                storage
            );

        ledger.ensureState(
            legacy
        );

        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json,
                    now:
                        () =>
                            1800000000000
                }
            );

        const result =
            migration.migrate();

        assert.equal(
            result.migrated,
            true
        );

        assert.equal(
            result.recoveredMarker,
            true
        );

        assert.equal(
            result.source,
            "legacy-json-recovered"
        );

        assert.deepEqual(
            result.state,
            legacy
        );

        pass(
            "RECOVERS_MISSING_MIGRATION_MARKER"
        );
    }
);


runCase(
    "conflict",
    (storage, paths) => {
        fs.writeFileSync(
            paths.json,
            JSON.stringify({
                cutoffTimestamp:
                    1712222222222,
                lastCheckedHeight:
                    50,
                accruedBudget:
                    20
            }),
            "utf8"
        );

        const ledger =
            new PayoutLedger(
                storage
            );

        ledger.ensureState({
            cutoffTimestamp:
                1712222222222,
            lastCheckedHeight:
                51,
            accruedBudget:
                20
        });

        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json
                }
            );

        assert.throws(
            () =>
                migration.migrate(),
            /KONFLIKT/
        );

        pass(
            "CONFLICT_FAILS_CLOSED"
        );
    }
);


runCase(
    "invalid-json",
    (storage, paths) => {
        fs.writeFileSync(
            paths.json,
            "{broken-json",
            "utf8"
        );

        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json
                }
            );

        assert.throws(
            () =>
                migration.migrate(),
            /Nieprawidlowy JSON/
        );

        const ledger =
            new PayoutLedger(
                storage
            );

        assert.equal(
            ledger.getState(),
            null
        );

        pass(
            "INVALID_JSON_CREATES_NO_STATE"
        );
    }
);


runCase(
    "missing-with-credit",
    (storage, paths) => {
        storage.saveCredit({
            minerAddress:
                "BbC" +
                "a".repeat(40),
            blockHeight: 1,
            shares: 1,
            amount: 1,
            timestamp:
                1713333333333
        });

        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json
                }
            );

        assert.equal(
            fs.existsSync(
                paths.json
            ),
            false
        );

        assert.throws(
            () =>
                migration.migrate(),
            /brak legacy payout state/
        );

        const ledger =
            new PayoutLedger(
                storage
            );

        assert.equal(
            ledger.getState(),
            null
        );

        pass(
            "MISSING_STATE_WITH_CREDITS_FAILS_CLOSED"
        );
    }
);


runCase(
    "fresh-empty",
    (storage, paths) => {
        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath:
                        paths.json,
                    now:
                        () =>
                            1714444444444
                }
            );

        const result =
            migration.migrate();

        assert.equal(
            result.migrated,
            true
        );

        assert.equal(
            result.fresh,
            true
        );

        assert.equal(
            result.source,
            "fresh-empty"
        );

        assert.equal(
            result.state
                .cutoffTimestamp,
            1714444444444
        );

        assert.equal(
            result.state
                .lastCheckedHeight,
            -1
        );

        assert.equal(
            result.state
                .accruedBudget,
            0
        );

        pass(
            "FRESH_EMPTY_INSTALL_CAN_INITIALIZE"
        );
    }
);


console.log("");
console.log(
    "RESULT PAYOUT STATE MIGRATION: 7/7 PASS"
);
