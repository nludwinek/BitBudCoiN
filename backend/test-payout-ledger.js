"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Storage = require("./storage");
const PayoutLedger = require("./payout-ledger");

const dbPath = path.join(
    os.tmpdir(),
    "bbc-payout-ledger-" +
        process.pid +
        "-" +
        Date.now() +
        ".db"
);

const A = "BbC" + "a".repeat(40);
const B = "BbC" + "b".repeat(40);
const POOL = "BbC" + "c".repeat(40);

function cleanup() {
    for (const suffix of [
        "",
        "-wal",
        "-shm"
    ]) {
        try {
            fs.unlinkSync(
                dbPath + suffix
            );
        } catch {}
    }
}

function saveCredit(
    storage,
    minerAddress,
    amount,
    timestamp,
    blockHeight = 1
) {
    storage.saveCredit({
        minerAddress,
        blockHeight,
        shares: 1,
        amount,
        timestamp
    });
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
        new Storage(dbPath);

    let ledger =
        new PayoutLedger(storage);

    const state =
        ledger.ensureState({
            cutoffTimestamp: 1000,
            lastCheckedHeight: 0,
            accruedBudget: 5
        });

    assert.equal(
        state.cutoffTimestamp,
        1000
    );

    assert.equal(
        state.accruedBudget,
        5
    );

    pass("STATE_INIT");


    const advance =
        ledger.advanceLegacyBudget(
            0,
            10,
            0
        );

    assert.equal(
        advance.advanced,
        true
    );

    const staleAdvance =
        ledger.advanceLegacyBudget(
            0,
            11,
            100
        );

    assert.equal(
        staleAdvance.advanced,
        false
    );

    assert.equal(
        staleAdvance.state.accruedBudget,
        5
    );

    pass("STATE_CAS");


    saveCredit(
        storage,
        A,
        2,
        2000
    );

    saveCredit(
        storage,
        A,
        3,
        2001
    );

    const current =
        ledger.reserveCurrent({
            batchId: "current-1",
            minerAddress: A,
            fromAddress: POOL,
            cutoffMs: 1000,
            minPayout: 1,
            fee: 0.01,
            txTimestamp: 5000
        });

    assert(current);

    assert.equal(
        current.amount,
        5
    );

    assert.equal(
        current.creditIds.length,
        2
    );

    pass("CURRENT_RESERVATION");


    saveCredit(
        storage,
        A,
        7,
        2002
    );

    const secondStorage =
        new Storage(dbPath);

    const secondLedger =
        new PayoutLedger(
            secondStorage
        );

    const duplicate =
        secondLedger.reserveCurrent({
            batchId: "current-2",
            minerAddress: A,
            fromAddress: POOL,
            cutoffMs: 1000,
            minPayout: 1,
            fee: 0.01,
            txTimestamp: 5001
        });

    assert.equal(
        duplicate,
        null
    );

    secondStorage.close();

    pass("ATOMIC_DOUBLE_RESERVATION_BLOCKED");


    const candidate = {
        from: POOL,
        to: A,
        amount: 5,
        fee: 0.01,
        timestamp: 5000,
        publicKey: "TEST_PUBLIC_KEY",
        signature: "sig-current-1"
    };

    ledger.attachCandidate(
        "current-1",
        candidate
    );

    ledger.markSubmitted(
        "current-1"
    );

    storage.close();
    storage = null;


    storage =
        new Storage(dbPath);

    ledger =
        new PayoutLedger(storage);

    const recovered =
        ledger.getActiveBatches();

    assert.equal(
        recovered.length,
        1
    );

    assert.equal(
        recovered[0].batchId,
        "current-1"
    );

    assert.equal(
        recovered[0].candidate.signature,
        "sig-current-1"
    );

    pass("CRASH_RECOVERY_PERSISTED");


    storage.saveMempoolTx({
        from: POOL,
        to: A,
        amount: 5,
        fee: 0.01,
        timestamp: 5000,
        publicKey: "TEST_PUBLIC_KEY",
        signature: "sig-current-1",
        receivedAt: Date.now()
    });

    const pendingEvidence =
        ledger.getEvidence(
            "sig-current-1"
        );

    assert.equal(
        pendingEvidence.pending,
        true
    );

    assert.equal(
        pendingEvidence.confirmed,
        false
    );

    pass("MEMPOOL_SIGNATURE_EVIDENCE");


    assert.throws(
        () =>
            ledger.finalize(
                "current-1"
            ),
        /potwierdzony/
    );

    pass("FINALIZE_REQUIRES_CHAIN_CONFIRMATION");


    storage.deleteMempoolTx(
        "sig-current-1"
    );

    storage.saveBlock({
        height: 1,
        timestamp: 6000,
        previousHash:
            "0".repeat(64),
        hash:
            "1".repeat(64),
        nonce: 0,
        difficulty: 1,
        transactions: [
            {
                from: POOL,
                to: A,
                amount: 5,
                type: "transfer",
                fee: 0.01,
                timestamp: 5000,
                publicKey:
                    "TEST_PUBLIC_KEY",
                signature:
                    "sig-current-1"
            }
        ]
    });

    const confirmedEvidence =
        ledger.getEvidence(
            "sig-current-1"
        );

    assert.equal(
        confirmedEvidence.pending,
        false
    );

    assert.equal(
        confirmedEvidence.confirmed,
        true
    );

    pass("CHAIN_SIGNATURE_EVIDENCE");


    const finalized =
        ledger.finalize(
            "current-1"
        );

    assert.equal(
        finalized.state,
        "confirmed"
    );

    assert.equal(
        finalized.wasFirstPayout,
        1
    );

    const currentRows =
        storage.db.prepare(`
            SELECT
                amount,
                paid,
                payoutBatchId
            FROM pool_credits
            WHERE minerAddress = ?
            ORDER BY id ASC
        `).all(A);

    assert.equal(
        currentRows.length,
        3
    );

    assert.equal(
        currentRows[0].paid,
        1
    );

    assert.equal(
        currentRows[1].paid,
        1
    );

    assert.equal(
        currentRows[0].payoutBatchId,
        "current-1"
    );

    assert.equal(
        currentRows[1].payoutBatchId,
        "current-1"
    );

    assert.equal(
        currentRows[2].paid,
        0
    );

    assert.equal(
        currentRows[2].payoutBatchId,
        null
    );

    pass("NEW_CREDIT_NOT_FALSELY_PAID");
    pass("CONFIRMED_CREDITS_KEEP_BATCH_AUDIT_LINK");


    saveCredit(
        storage,
        B,
        2,
        500
    );

    saveCredit(
        storage,
        B,
        2,
        501
    );

    saveCredit(
        storage,
        B,
        2,
        502
    );

    const legacy =
        ledger.reserveLegacy({
            batchId: "legacy-1",
            minerAddress: B,
            fromAddress: POOL,
            cutoffMs: 1000,
            maxAmount: 100,
            fee: 0.01,
            txTimestamp: 7000
        });

    assert(legacy);

    assert.equal(
        legacy.amount,
        4
    );

    assert.equal(
        legacy.creditIds.length,
        2
    );

    const legacySecond =
        ledger.reserveLegacy({
            batchId: "legacy-2",
            minerAddress: A,
            fromAddress: POOL,
            cutoffMs: 1000,
            maxAmount: 100,
            fee: 0.01,
            txTimestamp: 7001
        });

    assert.equal(
        legacySecond,
        null
    );

    ledger.attachCandidate(
        "legacy-1",
        {
            from: POOL,
            to: B,
            amount: 4,
            fee: 0.01,
            timestamp: 7000,
            publicKey:
                "TEST_PUBLIC_KEY",
            signature:
                "sig-legacy-1"
        }
    );

    ledger.markSubmitted(
        "legacy-1"
    );

    assert.throws(
        () =>
            ledger.finalize(
                "legacy-1"
            ),
        /potwierdzony/
    );

    storage.saveBlock({
        height: 2,
        timestamp: 7000,
        previousHash:
            "1".repeat(64),
        hash:
            "2".repeat(64),
        nonce: 0,
        difficulty: 1,
        transactions: [
            {
                from: POOL,
                to: B,
                amount: 4,
                type: "transfer",
                fee: 0.01,
                timestamp: 7000,
                publicKey:
                    "TEST_PUBLIC_KEY",
                signature:
                    "sig-legacy-1"
            }
        ]
    });

    const legacyEvidence =
        ledger.getEvidence(
            "sig-legacy-1"
        );

    assert.equal(
        legacyEvidence.confirmed,
        true
    );

    ledger.finalize(
        "legacy-1"
    );

    const afterLegacy =
        ledger.getState();

    assert.equal(
        afterLegacy.accruedBudget,
        1
    );

    const legacyRows =
        storage.db.prepare(`
            SELECT amount, paid
            FROM pool_credits
            WHERE
                minerAddress = ?
                AND timestamp < 1000
            ORDER BY id ASC
        `).all(B);

    assert.deepEqual(
        legacyRows.map(
            (row) => row.paid
        ),
        [1, 1, 0]
    );

    pass("LEGACY_BUDGET_ATOMIC_FINALIZE");


    saveCredit(
        storage,
        B,
        1.5,
        3000,
        2
    );

    const failed =
        ledger.reserveCurrent({
            batchId: "failed-1",
            minerAddress: B,
            fromAddress: POOL,
            cutoffMs: 1000,
            minPayout: 1,
            fee: 0.01,
            txTimestamp: 8000
        });

    assert(failed);

    ledger.fail(
        "failed-1",
        "TEST_REJECT"
    );

    const retry =
        ledger.reserveCurrent({
            batchId: "retry-1",
            minerAddress: B,
            fromAddress: POOL,
            cutoffMs: 1000,
            minPayout: 1,
            fee: 0.01,
            txTimestamp: 8001
        });

    assert(retry);

    assert.equal(
        retry.amount,
        1.5
    );

    pass("FAILED_BATCH_RELEASES_CREDITS");


    const submittedHold =
        ledger.reserveCurrent({
            batchId:
                "submitted-hold-1",
            minerAddress: A,
            fromAddress: POOL,
            cutoffMs: 1000,
            minPayout: 1,
            fee: 0.01,
            txTimestamp: 9000
        });

    assert(submittedHold);

    ledger.attachCandidate(
        "submitted-hold-1",
        {
            from: POOL,
            to: A,
            amount:
                submittedHold.amount,
            fee: 0.01,
            timestamp: 9000,
            publicKey:
                "TEST_PUBLIC_KEY",
            signature:
                "sig-submitted-hold-1"
        }
    );

    ledger.markSubmitted(
        "submitted-hold-1"
    );

    assert.throws(
        () =>
            ledger.fail(
                "submitted-hold-1",
                "NETWORK_UNKNOWN"
            ),
        /submitted/
    );

    const heldBatch =
        ledger.getBatch(
            "submitted-hold-1"
        );

    assert.equal(
        heldBatch.state,
        "submitted"
    );

    assert(
        heldBatch.creditIds.length > 0
    );

    pass("SUBMITTED_BATCH_CANNOT_RELEASE_CREDITS");


    const referralPending =
        ledger.getReferralPending();

    assert.equal(
        referralPending.length,
        2
    );

    ledger.markReferralProcessed(
        "current-1"
    );

    assert.equal(
        ledger
            .getReferralPending()
            .some(
                (batch) =>
                    batch.batchId ===
                    "current-1"
            ),
        false
    );

    pass("REFERRAL_FINALIZATION_MARKER");


    console.log("");
    console.log(
        "RESULT PAYOUT LEDGER: 14/14 PASS"
    );
} finally {
    if (storage) {
        try {
            storage.close();
        } catch {}
    }

    cleanup();
}
