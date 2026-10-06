"use strict";

const assert =
    require("assert");

const crypto =
    require("crypto");

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
    deriveAddress
} = require("./wallet");

const {
    main,
    isLoopbackServerUrl
} = require("./payout");


const stamp =
    process.pid +
    "-" +
    Date.now();

const dbPath =
    path.join(
        os.tmpdir(),
        "bbc-payout-integration-" +
            stamp +
            ".db"
    );

const statePath =
    path.join(
        os.tmpdir(),
        "bbc-payout-integration-" +
            stamp +
            ".json"
    );

const keyPath =
    path.join(
        os.tmpdir(),
        "bbc-payout-integration-" +
            stamp +
            ".pem"
    );

const MINER =
    "BbC" + "a".repeat(40);


function cleanup() {
    for (
        const file of [
            dbPath,
            dbPath + "-wal",
            dbPath + "-shm",
            statePath,
            keyPath
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


function makeBlock(
    height,
    candidate
) {
    return {
        height,
        timestamp:
            candidate.timestamp,
        previousHash:
            "0".repeat(64),
        hash:
            String(height)
                .padStart(
                    64,
                    "1"
                )
                .slice(
                    0,
                    64
                ),
        nonce: 0,
        difficulty: 1,
        transactions: [
            {
                ...candidate,
                type:
                    "transfer"
            }
        ]
    };
}


cleanup();

(async () => {
    let bootstrap = null;
    let inspect = null;

    try {
        const {
            publicKey,
            privateKey
        } =
            crypto
                .generateKeyPairSync(
                    "ed25519"
                );

        const privatePem =
            privateKey.export({
                type: "pkcs8",
                format: "pem"
            });

        const publicPem =
            publicKey.export({
                type: "spki",
                format: "pem"
            });

        const poolAddress =
            deriveAddress(
                publicPem
            );

        fs.writeFileSync(
            keyPath,
            privatePem,
            "utf8"
        );


        assert.equal(
            isLoopbackServerUrl(
                "http://localhost:5000"
            ),
            true
        );

        assert.equal(
            isLoopbackServerUrl(
                "http://127.0.0.1:5000"
            ),
            true
        );

        assert.equal(
            isLoopbackServerUrl(
                "http://127.12.34.56:5000"
            ),
            true
        );

        assert.equal(
            isLoopbackServerUrl(
                "http://[::1]:5000"
            ),
            true
        );

        assert.equal(
            isLoopbackServerUrl(
                "https://141.147.98.57"
            ),
            false
        );

        assert.equal(
            isLoopbackServerUrl(
                "https://example.com"
            ),
            false
        );

        await assert.rejects(
            () =>
                main(
                    keyPath,
                    "https://141.147.98.57",
                    1,
                    {
                        databasePath:
                            dbPath,
                        statePath,
                        expectedPoolAddress:
                            poolAddress,
                        log: false
                    }
                ),
            /lokalnego wezla/
        );

        pass(
            "REMOTE_HTTP_PAYOUT_FAILS_CLOSED"
        );


        const legacyState = {
            cutoffTimestamp:
                1710000000000,
            lastCheckedHeight:
                0,
            accruedBudget:
                12.5
        };

        fs.writeFileSync(
            statePath,
            JSON.stringify(
                legacyState,
                null,
                2
            ),
            "utf8"
        );

        bootstrap =
            new Storage(
                dbPath
            );

        bootstrap.saveCredit({
            minerAddress:
                MINER,
            blockHeight: 1,
            shares: 1,
            amount: 5,
            timestamp:
                legacyState
                    .cutoffTimestamp +
                1000
        });

        bootstrap.close();
        bootstrap = null;


        let firstNetworkCalls =
            0;

        let acceptedCandidate =
            null;

        const first =
            await main(
                keyPath,
                "http://test",
                1,
                {
                    databasePath:
                        dbPath,
                    statePath,
                    expectedPoolAddress:
                        poolAddress,
                    delayMs: 0,
                    log: false,
                    submitFn:
                        async (
                            candidate
                        ) => {
                            firstNetworkCalls++;

                            acceptedCandidate =
                                JSON.parse(
                                    JSON.stringify(
                                        candidate
                                    )
                                );

                            const serverStorage =
                                new Storage(
                                    dbPath
                                );

                            try {
                                serverStorage
                                    .saveMempoolTx({
                                        ...candidate,
                                        receivedAt:
                                            Date.now()
                                    });
                            } finally {
                                serverStorage.close();
                            }

                            return {
                                kind:
                                    "accepted",
                                status: 200,
                                data: {
                                    accepted:
                                        true,
                                    signature:
                                        candidate
                                            .signature
                                },
                                reason: ""
                            };
                        }
                }
            );

        assert.equal(
            firstNetworkCalls,
            1
        );

        assert(
            acceptedCandidate
        );

        assert.equal(
            first.migration
                .source,
            "legacy-json"
        );

        assert.equal(
            first.migration
                .state
                .cutoffTimestamp,
            legacyState
                .cutoffTimestamp
        );

        assert.equal(
            first.migration
                .state
                .lastCheckedHeight,
            legacyState
                .lastCheckedHeight
        );

        assert.equal(
            Number(
                first.migration
                    .state
                    .accruedBudget
            ),
            legacyState
                .accruedBudget
        );

        pass(
            "PAYOUT_JS_MIGRATES_EXACT_LEGACY_STATE"
        );


        inspect =
            new Storage(
                dbPath
            );

        let ledger =
            new PayoutLedger(
                inspect
            );

        let active =
            ledger
                .getActiveBatches();

        assert.equal(
            active.length,
            1
        );

        assert.equal(
            active[0].state,
            "submitted"
        );

        assert.equal(
            active[0]
                .txSignature,
            acceptedCandidate
                .signature
        );

        assert.equal(
            inspect.db.prepare(`
                SELECT paid
                FROM pool_credits
                WHERE minerAddress = ?
            `).get(
                MINER
            ).paid,
            0
        );

        pass(
            "PAYOUT_JS_DOES_NOT_MARK_MEMPOOL_TX_PAID"
        );


        inspect.deleteMempoolTx(
            acceptedCandidate
                .signature
        );

        inspect.saveBlock(
            makeBlock(
                1,
                acceptedCandidate
            )
        );

        inspect.close();
        inspect = null;


        let secondNetworkCalls =
            0;

        const second =
            await main(
                keyPath,
                "http://test",
                1,
                {
                    databasePath:
                        dbPath,
                    statePath,
                    expectedPoolAddress:
                        poolAddress,
                    delayMs: 0,
                    log: false,
                    submitFn:
                        async () => {
                            secondNetworkCalls++;

                            throw new Error(
                                "NETWORK_SHOULD_NOT_BE_USED"
                            );
                        }
                }
            );

        assert.equal(
            secondNetworkCalls,
            0
        );

        assert.equal(
            second.migration
                .source,
            "database"
        );

        pass(
            "RESTART_USES_DATABASE_STATE"
        );


        inspect =
            new Storage(
                dbPath
            );

        ledger =
            new PayoutLedger(
                inspect
            );

        active =
            ledger
                .getActiveBatches();

        assert.equal(
            active.length,
            0
        );

        const credit =
            inspect.db.prepare(`
                SELECT
                    paid,
                    payoutBatchId
                FROM pool_credits
                WHERE
                    minerAddress = ?
                    AND shares = 1
            `).get(
                MINER
            );

        assert.equal(
            credit.paid,
            1
        );

        assert(
            typeof credit
                .payoutBatchId ===
                "string" &&
            credit
                .payoutBatchId
                .length > 0
        );

        pass(
            "CONFIRMED_TX_FINALIZES_EXACT_CREDITS"
        );


        const batches =
            inspect.db.prepare(`
                SELECT
                    state,
                    txSignature
                FROM payout_batches
                WHERE minerAddress = ?
            `).all(
                MINER
            );

        assert.equal(
            batches.length,
            1
        );

        assert.equal(
            batches[0].state,
            "confirmed"
        );

        assert.equal(
            batches[0]
                .txSignature,
            acceptedCandidate
                .signature
        );

        pass(
            "ONE_DURABLE_BATCH_FOR_PAYMENT"
        );


        /*
         * payout.js nie importuje starego growth.js.
         * ReferralReward powinien sam utworzyc potrzebny schemat.
         */
        const growthUsers =
            inspect.db.prepare(`
                SELECT name
                FROM sqlite_master
                WHERE
                    type = 'table'
                    AND name =
                        'growth_users'
            `).get();

        const growthEvents =
            inspect.db.prepare(`
                SELECT name
                FROM sqlite_master
                WHERE
                    type = 'table'
                    AND name =
                        'growth_events'
            `).get();

        assert(growthUsers);
        assert(growthEvents);

        pass(
            "PAYOUT_BOOTSTRAPS_REFERRAL_SCHEMA_WITHOUT_GROWTH_SIDE_EFFECT"
        );


        assert.equal(
            fs.existsSync(
                statePath
            ),
            true
        );

        const jsonStillOld =
            JSON.parse(
                fs.readFileSync(
                    statePath,
                    "utf8"
                )
            );

        assert.deepEqual(
            jsonStillOld,
            legacyState
        );

        const dbState =
            ledger.getState();

        assert.equal(
            dbState
                .cutoffTimestamp,
            legacyState
                .cutoffTimestamp
        );

        pass(
            "LEGACY_JSON_IS_NOT_REWRITTEN_AFTER_MIGRATION"
        );


        console.log("");
        console.log(
            "RESULT PAYOUT INTEGRATION: 8/8 PASS"
        );
    } finally {
        if (bootstrap) {
            try {
                bootstrap.close();
            } catch {}
        }

        if (inspect) {
            try {
                inspect.close();
            } catch {}
        }

        cleanup();
    }
})().catch(
    (err) => {
        console.error(err);
        process.exitCode = 1;
    }
);
