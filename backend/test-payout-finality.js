"use strict";

const assert =
    require("node:assert/strict");

const fs =
    require("node:fs");

const os =
    require("node:os");

const path =
    require("node:path");

const Storage =
    require("./storage");

const PayoutLedger =
    require("./payout-ledger");

const {
    PayoutEngine
} =
    require("./payout-engine");

const CONFIG =
    require("./config");


const dbPath =
    path.join(
        os.tmpdir(),
        "bbc-payout-finality-" +
            process.pid +
            "-" +
            Date.now() +
            ".db"
    );


const POOL =
    "BbC" +
    "f".repeat(40);

const MINER_A =
    "BbC" +
    "a".repeat(40);

const MINER_B =
    "BbC" +
    "b".repeat(40);


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


function hashForHeight(height) {

    return (
        height + 1
    )
        .toString(16)
        .padStart(
            64,
            "0"
        );
}


function makeBlock(
    height,
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
                : hashForHeight(
                    height - 1
                ),

        hash:
            hashForHeight(
                height
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


function makeTx(
    signature,
    to,
    amount,
    timestamp
) {

    return {
        from:
            POOL,

        to,

        amount,

        type:
            "transfer",

        fee:
            0.01,

        timestamp,

        publicKey:
            "TEST_PUBLIC_KEY",

        signature
    };
}


function saveCredit(
    minerAddress,
    amount,
    timestamp,
    blockHeight
) {

    storage.saveCredit({
        minerAddress,
        blockHeight,
        shares: 1,
        amount,
        timestamp
    });
}


async function main() {

    cleanup();

    storage =
        new Storage(
            dbPath
        );


    storage.saveBlock(
        makeBlock(0)
    );


    assert.equal(
        CONFIG.PAYOUT_MIN_CONFIRMATIONS,
        12
    );

    pass(
        "CONFIG_REQUIRES_12_CONFIRMATIONS"
    );


    /*
     * ========================================================
     * LEDGER: 11 confirmations
     * ========================================================
     */

    const ledger =
        new PayoutLedger(
            storage,
            {
                minConfirmations: 12
            }
        );


    saveCredit(
        MINER_A,
        5,
        2000,
        0
    );


    let batchA =
        ledger.reserveCurrent({
            batchId:
                "finality-a",

            minerAddress:
                MINER_A,

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
        batchA
    );


    const txA =
        makeTx(
            "FINALITY_SIGNATURE_A",
            MINER_A,
            batchA.amount,
            3000
        );


    batchA =
        ledger.attachCandidate(
            batchA.batchId,
            txA
        );


    batchA =
        ledger.markSubmitted(
            batchA.batchId
        );


    storage.saveBlock(
        makeBlock(
            1,
            txA
        )
    );


    for (
        let h = 2;
        h <= 11;
        h++
    ) {

        storage.saveBlock(
            makeBlock(h)
        );
    }


    const evidence11 =
        ledger.getEvidence(
            txA.signature
        );


    assert.equal(
        evidence11.included,
        true
    );

    assert.equal(
        evidence11.confirmations,
        11
    );

    assert.equal(
        evidence11.requiredConfirmations,
        12
    );

    assert.equal(
        evidence11.confirmed,
        false
    );


    pass(
        "ELEVEN_CONFIRMATIONS_NOT_FINAL"
    );


    assert.throws(
        () =>
            ledger.finalize(
                batchA.batchId
            ),
        /potwierdzony/
    );


    assert.throws(
        () =>
            ledger.rejectSubmitted(
                batchA.batchId,
                "TEST_ONLY"
            ),
        /dowodem/
    );


    const heldA =
        storage.db.prepare(`
            SELECT
                paid,
                payoutBatchId
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(
            MINER_A
        );


    assert.equal(
        heldA.paid,
        0
    );

    assert.equal(
        heldA.payoutBatchId,
        batchA.batchId
    );


    pass(
        "IMMATURE_INCLUDED_TX_HOLDS_CREDITS"
    );


    /*
     * ========================================================
     * 12 confirmations
     * ========================================================
     */

    storage.saveBlock(
        makeBlock(12)
    );


    const evidence12 =
        ledger.getEvidence(
            txA.signature
        );


    assert.equal(
        evidence12.confirmations,
        12
    );

    assert.equal(
        evidence12.confirmed,
        true
    );


    ledger.finalize(
        batchA.batchId
    );


    assert.equal(
        storage.db.prepare(`
            SELECT paid
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(
            MINER_A
        ).paid,
        1
    );


    pass(
        "TWELVE_CONFIRMATIONS_FINALIZE"
    );


    /*
     * ========================================================
     * ENGINE: included immature = zero network calls
     * ========================================================
     */

    let networkCalls = 0;


    const engine =
        new PayoutEngine({
            storage,

            privateKey:
                "UNUSED_PRIVATE_KEY",

            publicKey:
                "UNUSED_PUBLIC_KEY",

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

                    networkCalls++;

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


    saveCredit(
        MINER_B,
        7,
        4000,
        12
    );


    let batchB =
        engine.ledger
            .reserveCurrent({
                batchId:
                    "finality-b",

                minerAddress:
                    MINER_B,

                fromAddress:
                    POOL,

                cutoffMs:
                    3000,

                minPayout:
                    1,

                fee:
                    0.01,

                txTimestamp:
                    5000
            });


    assert.ok(
        batchB
    );


    const txB =
        makeTx(
            "FINALITY_SIGNATURE_B",
            MINER_B,
            batchB.amount,
            5000
        );


    batchB =
        engine.ledger
            .attachCandidate(
                batchB.batchId,
                txB
            );


    batchB =
        engine.ledger
            .markSubmitted(
                batchB.batchId
            );


    storage.saveBlock(
        makeBlock(
            20,
            txB
        )
    );


    const confirming =
        await engine.resolveBatch(
            batchB
        );


    assert.equal(
        confirming.status,
        "confirming"
    );

    assert.equal(
        confirming.evidence.included,
        true
    );

    assert.equal(
        confirming.evidence.confirmed,
        false
    );

    assert.equal(
        confirming.evidence.confirmations,
        1
    );

    assert.equal(
        networkCalls,
        0
    );


    assert.equal(
        storage.db.prepare(`
            SELECT paid
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(
            MINER_B
        ).paid,
        0
    );


    pass(
        "INCLUDED_IMMATURE_TX_ZERO_REBROADCAST"
    );


    for (
        let h = 21;
        h <= 31;
        h++
    ) {

        storage.saveBlock(
            makeBlock(h)
        );
    }


    const recovered =
        await engine
            .recoverActive();


    const resultB =
        recovered.find(
            (item) =>
                item.batch &&
                item.batch.batchId ===
                    batchB.batchId
        );


    assert.ok(
        resultB
    );

    assert.equal(
        resultB.status,
        "confirmed"
    );

    assert.equal(
        resultB.evidence.confirmations,
        12
    );

    assert.equal(
        networkCalls,
        0
    );


    assert.equal(
        storage.db.prepare(`
            SELECT paid
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(
            MINER_B
        ).paid,
        1
    );


    pass(
        "ENGINE_FINALIZES_AT_12_WITHOUT_REBROADCAST"
    );


    assert.throws(
        () =>
            new PayoutLedger(
                storage,
                {
                    minConfirmations:
                        0
                }
            ),
        /potwierdzen/
    );


    pass(
        "INVALID_CONFIRMATION_POLICY_FAILS_CLOSED"
    );


    console.log("");

    console.log(
        `RESULT PAYOUT FINALITY: ${passed}/7 PASS`
    );


    if (passed !== 7) {
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
