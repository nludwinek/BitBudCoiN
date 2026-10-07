"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Storage = require("./storage");
const PayoutLedger = require("./payout-ledger");


const MINER =
    "BbC" + "a".repeat(40);

const POOL =
    "BbC" + "f".repeat(40);

const dbPath =
    path.join(
        os.tmpdir(),
        "bbc-signed-reserved-" +
            process.pid +
            "-" +
            Date.now() +
            ".db"
    );


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


function pass(name) {
    console.log(
        "PASS " + name
    );
}


cleanup();

let storage = null;

try {
    storage =
        new Storage(
            dbPath
        );

    storage.saveCredit({
        minerAddress:
            MINER,
        blockHeight: 1,
        shares: 1,
        amount: 5,
        timestamp: 2000
    });

    const ledger =
        new PayoutLedger(
            storage
        );

    ledger.ensureState({
        cutoffTimestamp: 1000,
        lastCheckedHeight: 0,
        accruedBudget: 0
    });

    const batch =
        ledger.reserveCurrent({
            batchId:
                "signed-reserved-test",
            minerAddress:
                MINER,
            fromAddress:
                POOL,
            cutoffMs: 1000,
            minPayout: 1,
            fee: 0.01,
            txTimestamp: 3000
        });

    assert(batch);

    assert.equal(
        batch.state,
        "reserved"
    );

    const candidate = {
        from:
            POOL,
        to:
            MINER,
        amount:
            Number(
                batch.amount
            ),
        fee:
            Number(
                batch.fee
            ),
        timestamp:
            batch.txTimestamp,
        publicKey:
            "test-public-key",
        signature:
            "signed-reserved-signature-1"
    };

    const attached =
        ledger.attachCandidate(
            batch.batchId,
            candidate
        );

    assert.equal(
        attached.state,
        "reserved"
    );

    assert.equal(
        attached.txSignature,
        candidate.signature
    );

    assert(
        attached.candidate
    );


    /*
     * Najwazniejsza asercja:
     * podpisany reserved batch NIE moze zwolnic credits.
     */
    assert.throws(
        () =>
            ledger.fail(
                batch.batchId,
                "SIMULATED_FAILURE"
            ),
        /podpisanego reserved batch/
    );


    const afterFailAttempt =
        ledger.getBatch(
            batch.batchId
        );

    assert.equal(
        afterFailAttempt.state,
        "reserved"
    );

    assert.equal(
        afterFailAttempt.txSignature,
        candidate.signature
    );

    const credit =
        storage.db.prepare(`
            SELECT
                paid,
                payoutBatchId
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(
            MINER
        );

    assert.equal(
        credit.paid,
        0
    );

    assert.equal(
        credit.payoutBatchId,
        batch.batchId
    );

    pass(
        "SIGNED_RESERVED_CANNOT_RELEASE_CREDITS"
    );


    /*
     * Recovery path pozostaje poprawny:
     * ten sam podpisany reserved batch moze przejsc do submitted.
     */
    const submitted =
        ledger.markSubmitted(
            batch.batchId
        );

    assert.equal(
        submitted.state,
        "submitted"
    );

    assert.equal(
        submitted.txSignature,
        candidate.signature
    );

    assert.deepEqual(
        submitted.candidate,
        candidate
    );

    const creditAfterSubmit =
        storage.db.prepare(`
            SELECT
                paid,
                payoutBatchId
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(
            MINER
        );

    assert.equal(
        creditAfterSubmit.paid,
        0
    );

    assert.equal(
        creditAfterSubmit
            .payoutBatchId,
        batch.batchId
    );

    pass(
        "SIGNED_RESERVED_RECOVERS_WITH_SAME_CANDIDATE"
    );


    console.log("");
    console.log(
        "RESULT SIGNED RESERVED: 2/2 PASS"
    );
} finally {
    if (storage) {
        try {
            storage.close();
        } catch {}
    }

    cleanup();
}
