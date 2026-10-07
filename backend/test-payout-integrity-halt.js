"use strict";

const assert =
    require("node:assert/strict");

const fs =
    require("node:fs");

const os =
    require("node:os");

const path =
    require("node:path");


const CONFIG =
    require("./config");

const Storage =
    require("./storage");

const PayoutLedger =
    require("./payout-ledger");

const {
    PayoutEngine
} =
    require("./payout-engine");

const {
    getWakeState,
    checkAndPayout
} =
    require("./payout-watcher");


const originalDatabase =
    CONFIG.DATABASE;


const dbPath =
    path.join(
        os.tmpdir(),
        "bbc-integrity-halt-" +
            process.pid +
            "-" +
            Date.now() +
            ".db"
    );


const POOL =
    "BbC" +
    "f".repeat(40);

const MINER =
    "BbC" +
    "a".repeat(40);


let storage = null;

let passed = 0;


function pass(name) {

    passed++;

    console.log(
        "PASS " + name
    );
}


function cleanup() {

    for (
        const suffix of [
            "",
            "-wal",
            "-shm"
        ]
    ) {

        try {
            fs.unlinkSync(
                dbPath + suffix
            );
        } catch {}
    }
}


function hashFor(
    height,
    branch
) {

    return (
        branch.repeat(60) +
        Number(height)
            .toString(16)
            .padStart(
                4,
                "0"
            )
    );
}


function makeBlock(
    height,
    branch,
    tx = null
) {

    return {
        height,

        timestamp:
            100000 +
            height,

        previousHash:
            height === 0
                ? "0".repeat(64)
                : hashFor(
                    height - 1,
                    branch
                ),

        hash:
            hashFor(
                height,
                branch
            ),

        nonce:
            height,

        difficulty:
            1,

        transactions:
            tx
                ? [tx]
                : []
    };
}


function makeChain(
    maxHeight,
    branch,
    payoutTx = null
) {

    const chain = [];

    for (
        let height = 0;
        height <= maxHeight;
        height++
    ) {

        chain.push(
            makeBlock(
                height,
                branch,
                height === 1
                    ? payoutTx
                    : null
            )
        );
    }

    return chain;
}


function makeEngine(
    activeStorage,
    networkCounter
) {

    return new PayoutEngine({
        storage:
            activeStorage,

        privateKey:
            "TEST_PRIVATE_KEY",

        publicKey:
            "TEST_PUBLIC_KEY",

        poolAddress:
            POOL,

        serverUrl:
            "http://test",

        fee:
            0.01,

        minPayout:
            1,

        maxSinglePayout:
            100,

        minConfirmations:
            12,

        delayMs:
            0,

        submitFn:
            async () => {

                networkCounter.calls++;

                return {
                    kind:
                        "accepted",

                    status:
                        200,

                    data: {
                        accepted:
                            true
                    },

                    reason:
                        ""
                };
            }
    });
}


async function main() {

    cleanup();

    storage =
        new Storage(
            dbPath
        );


    const ledger =
        new PayoutLedger(
            storage,
            {
                minConfirmations:
                    12
            }
        );


    /*
     * ========================================================
     * Build a genuinely finalized payout
     * ========================================================
     */

    storage.saveBlock(
        makeBlock(
            0,
            "a"
        )
    );


    storage.saveCredit({
        minerAddress:
            MINER,

        blockHeight:
            0,

        shares:
            1,

        amount:
            5,

        timestamp:
            2000
    });


    let batch =
        ledger.reserveCurrent({
            batchId:
                "integrity-halt-batch",

            minerAddress:
                MINER,

            fromAddress:
                POOL,

            cutoffMs:
                1000,

            minPayout:
                1,

            fee:
                0.01,

            txTimestamp:
                3000
        });


    assert.ok(
        batch
    );


    const tx = {
        from:
            POOL,

        to:
            MINER,

        amount:
            batch.amount,

        type:
            "transfer",

        fee:
            0.01,

        timestamp:
            3000,

        publicKey:
            "TEST_PUBLIC_KEY",

        signature:
            "PERSISTENT_HALT_SIGNATURE"
    };


    batch =
        ledger.attachCandidate(
            batch.batchId,
            tx
        );


    batch =
        ledger.markSubmitted(
            batch.batchId
        );


    storage.saveBlock(
        makeBlock(
            1,
            "a",
            tx
        )
    );


    for (
        let h = 2;
        h <= 12;
        h++
    ) {

        storage.saveBlock(
            makeBlock(
                h,
                "a"
            )
        );
    }


    const before =
        ledger.getEvidence(
            tx.signature
        );


    assert.equal(
        before.confirmed,
        true
    );

    assert.equal(
        before.confirmations,
        12
    );


    ledger.finalize(
        batch.batchId
    );


    assert.equal(
        ledger.getBatch(
            batch.batchId
        ).state,
        "confirmed"
    );


    pass(
        "FINALIZED_PAYOUT_VALID_BEFORE_REORG"
    );


    /*
     * ========================================================
     * Deep canonical reorg removes the payout
     * ========================================================
     */

    storage.replaceAllBlocks(
        makeChain(
            13,
            "b",
            null
        )
    );


    const afterReorg =
        ledger.getEvidence(
            tx.signature
        );


    assert.equal(
        afterReorg.included,
        false
    );

    assert.equal(
        afterReorg.confirmed,
        false
    );


    /*
     * Krytyczny przypadek:
     * nie ma nowych payoutow ani active batch,
     * wiec sam watcher musi wykryc utrate finality.
     */
    const idleWake =
        getWakeState(
            storage,
            1
        );


    assert.equal(
        idleWake.integrityHalted,
        true
    );

    assert.equal(
        idleWake.shouldRun,
        false
    );


    const idleHalt =
        ledger.getIntegrityState();


    assert.equal(
        idleHalt.halted,
        true
    );

    assert.equal(
        idleHalt.reason,
        "CONFIRMED_PAYOUT_LOST_FINALITY"
    );

    assert.equal(
        idleHalt.batchId,
        batch.batchId
    );

    assert.equal(
        idleHalt.txSignature,
        tx.signature
    );

    assert.equal(
        idleHalt.evidence.confirmed,
        false
    );

    assert.equal(
        idleHalt.evidence
            .requiredConfirmations,
        12
    );


    pass(
        "WATCHER_DETECTS_IDLE_DEEP_REORG"
    );


    const network =
        {
            calls: 0
        };


    const engine =
        makeEngine(
            storage,
            network
        );


    await assert.rejects(
        () =>
            engine.runCycle({
                cutoffTimestamp:
                    1000,

                rewardForHeight:
                    () => 50,

                legacyShare:
                    0.1,

                minLegacyPayout:
                    0.01
            }),

        (err) =>
            err &&
            err.code ===
                "PAYOUT_INTEGRITY_HALT"
    );


    assert.equal(
        network.calls,
        0
    );


    pass(
        "INTEGRITY_FAILURE_OCCURS_BEFORE_NETWORK"
    );


    const credit =
        storage.db.prepare(`
            SELECT
                paid,
                payoutBatchId
            FROM pool_credits
            WHERE minerAddress = ?
            LIMIT 1
        `).get(
            MINER
        );


    assert.equal(
        credit.paid,
        1
    );


    pass(
        "HALT_DOES_NOT_AUTOMATICALLY_RECREDIT"
    );


    assert.equal(
        credit.payoutBatchId,
        batch.batchId
    );


    pass(
        "HALT_PRESERVES_CREDIT_AUDIT_LINK"
    );


    /*
     * ========================================================
     * Restart persistence
     * ========================================================
     */

    storage.close();

    storage = null;


    storage =
        new Storage(
            dbPath
        );


    const restartedLedger =
        new PayoutLedger(
            storage,
            {
                minConfirmations:
                    12
            }
        );


    const afterRestart =
        restartedLedger
            .getIntegrityState();


    assert.equal(
        afterRestart.halted,
        true
    );

    assert.equal(
        afterRestart.batchId,
        batch.batchId
    );


    pass(
        "HALT_SURVIVES_RESTART"
    );


    /*
     * ========================================================
     * Even if the chain later contains the payout again,
     * halt stays latched.
     * ========================================================
     */

    storage.replaceAllBlocks(
        makeChain(
            14,
            "c",
            tx
        )
    );


    const restoredEvidence =
        restartedLedger
            .getEvidence(
                tx.signature
            );


    assert.equal(
        restoredEvidence.confirmed,
        true
    );


    assert.equal(
        restartedLedger
            .getIntegrityState()
            .halted,
        true
    );


    pass(
        "HALT_DOES_NOT_AUTO_CLEAR_AFTER_CHAIN_RECOVERY"
    );


    /*
     * There is intentionally no programmatic auto-clear API.
     */
    assert.equal(
        typeof restartedLedger
            .clearIntegrityHalt,
        "undefined"
    );


    pass(
        "NO_AUTOMATIC_HALT_CLEAR_API"
    );


    /*
     * ========================================================
     * Watcher must not wake payout.js
     * ========================================================
     */

    const wake =
        getWakeState(
            storage,
            1
        );


    assert.equal(
        wake.integrityHalted,
        true
    );

    assert.equal(
        wake.shouldRun,
        false
    );


    pass(
        "WATCHER_SEES_PERSISTENT_HALT"
    );


    storage.close();

    storage = null;


    CONFIG.DATABASE =
        dbPath;


    let execCalls = 0;


    const launched =
        checkAndPayout({
            poolKeyPath:
                "TEST_POOL_KEY_PATH",

            minPayout:
                1,

            execFileImpl:
                () => {

                    execCalls++;

                    return {};
                }
        });


    assert.equal(
        launched,
        false
    );

    assert.equal(
        execCalls,
        0
    );


    pass(
        "WATCHER_ZERO_PAYOUT_EXEC_WHILE_HALTED"
    );


    /*
     * ========================================================
     * Direct engine money paths must also respect
     * an already-latched halt.
     * ========================================================
     */

    storage =
        new Storage(
            dbPath
        );


    const blockedNetwork =
        {
            calls: 0
        };


    const blockedEngine =
        makeEngine(
            storage,
            blockedNetwork
        );


    await assert.rejects(
        () =>
            blockedEngine
                .submitCurrent(
                    MINER,
                    1000
                ),

        (err) =>
            err &&
            err.code ===
                "PAYOUT_INTEGRITY_HALT"
    );


    assert.equal(
        blockedNetwork.calls,
        0
    );


    pass(
        "DIRECT_PAYOUT_BLOCKED_WHILE_HALTED"
    );


    await assert.rejects(
        () =>
            blockedEngine
                .processReferralPending(),

        (err) =>
            err &&
            err.code ===
                "PAYOUT_INTEGRITY_HALT"
    );


    pass(
        "REFERRAL_PROCESSING_BLOCKED_WHILE_HALTED"
    );


    console.log("");

    console.log(
        `RESULT PAYOUT INTEGRITY HALT: ${passed}/12 PASS`
    );


    if (passed !== 12) {
        process.exitCode = 1;
    }
}


main()
    .catch(
        (err) => {

            console.error(
                err
            );

            process.exitCode = 1;
        }
    )
    .finally(
        () => {

            CONFIG.DATABASE =
                originalDatabase;

            if (storage) {

                try {
                    storage.close();
                } catch {

                    try {
                        storage.db.close();
                    } catch {}
                }
            }

            cleanup();
        }
    );
