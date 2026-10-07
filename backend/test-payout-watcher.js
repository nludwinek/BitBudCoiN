"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Storage = require("./storage");
const PayoutLedger = require("./payout-ledger");

const {
    getWakeState
} = require("./payout-watcher");


const A =
    "BbC" + "a".repeat(40);

const POOL =
    "BbC" + "f".repeat(40);

let sequence = 0;


function pass(name) {
    console.log(
        "PASS " + name
    );
}


function nextDb(name) {
    sequence++;

    return path.join(
        os.tmpdir(),
        "bbc-watcher-" +
            process.pid +
            "-" +
            Date.now() +
            "-" +
            sequence +
            "-" +
            name +
            ".db"
    );
}


function cleanup(dbPath) {
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


function runCase(
    name,
    fn
) {
    const dbPath =
        nextDb(name);

    let storage = null;

    try {
        storage =
            new Storage(
                dbPath
            );

        fn(
            storage
        );
    } finally {
        if (storage) {
            try {
                storage.close();
            } catch {}
        }

        cleanup(
            dbPath
        );
    }
}


runCase(
    "empty",
    (storage) => {
        const wake =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            wake.shouldRun,
            false
        );

        pass(
            "EMPTY_DATABASE_DOES_NOT_WAKE"
        );
    }
);


runCase(
    "invalid",
    (storage) => {
        storage.saveCredit({
            minerAddress:
                "invalid-address",
            blockHeight: 0,
            shares: 1,
            amount: 10,
            timestamp:
                Date.now()
        });

        const wake =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            wake.shouldRun,
            false
        );

        assert.equal(
            wake.bootstrapUnpaid,
            0
        );

        pass(
            "INVALID_BOOTSTRAP_CREDIT_DOES_NOT_WAKE"
        );
    }
);


runCase(
    "bootstrap",
    (storage) => {
        storage.saveCredit({
            minerAddress: A,
            blockHeight: 0,
            shares: 1,
            amount: 2,
            timestamp:
                Date.now()
        });

        const wake =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            wake.shouldRun,
            true
        );

        assert.equal(
            wake.bootstrapUnpaid,
            1
        );

        pass(
            "BOOTSTRAP_UNPAID_WAKES_MIGRATION"
        );
    }
);


runCase(
    "active",
    (storage) => {
        const ledger =
            new PayoutLedger(
                storage
            );

        ledger.ensureState({
            cutoffTimestamp:
                1000,
            lastCheckedHeight:
                0,
            accruedBudget:
                0
        });

        storage.db.prepare(`
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
                createdAt,
                wasFirstPayout,
                referralProcessed
            )
            VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            "watch-active-1",
            "current",
            A,
            POOL,
            1,
            0.01,
            2000,
            "reserved",
            2000,
            0,
            0
        );

        const wake =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            wake.shouldRun,
            true
        );

        assert.equal(
            wake.activeBatches,
            1
        );

        assert.equal(
            storage
                .getUnpaidCreditsSummary()
                .length,
            0
        );

        pass(
            "ACTIVE_BATCH_WAKES_WITHOUT_UNPAID"
        );
    }
);


runCase(
    "referral",
    (storage) => {
        const ledger =
            new PayoutLedger(
                storage
            );

        ledger.ensureState({
            cutoffTimestamp:
                1000,
            lastCheckedHeight:
                0,
            accruedBudget:
                0
        });

        storage.db.prepare(`
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
                createdAt,
                confirmedAt,
                wasFirstPayout,
                referralProcessed,
                txSignature
            )
            VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            "watch-referral-1",
            "current",
            A,
            POOL,
            1,
            0.01,
            2000,
            "confirmed",
            2000,
            3000,
            1,
            0,
            "watch-referral-signature"
        );


        /*
         * Ten fixture reprezentuje prawdziwie confirmed payout.
         *
         * getWakeState(..., 1, 1) wymaga tylko jednej
         * confirmation, wiec block 0 wystarcza.
         */
        storage.saveBlock({
            height: 0,
            timestamp: 3000,
            previousHash:
                "0".repeat(64),
            hash:
                "a".repeat(64),
            nonce: 0,
            difficulty: 1,
            transactions: [
                {
                    from:
                        POOL,
                    to:
                        A,
                    amount:
                        1,
                    type:
                        "transfer",
                    fee:
                        0.01,
                    timestamp:
                        2000,
                    publicKey:
                        "TEST_PUBLIC_KEY",
                    signature:
                        "watch-referral-signature"
                }
            ]
        });

        assert.equal(
            storage
                .getUnpaidCreditsSummary()
                .length,
            0
        );

        const wake =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            wake.shouldRun,
            true
        );

        assert.equal(
            wake.pendingReferrals,
            1
        );

        ledger
            .markReferralProcessed(
                "watch-referral-1"
            );

        const after =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            after.shouldRun,
            false
        );

        pass(
            "REFERRAL_ONLY_RECOVERY_WAKES"
        );
    }
);


runCase(
    "threshold",
    (storage) => {
        const ledger =
            new PayoutLedger(
                storage
            );

        ledger.ensureState({
            cutoffTimestamp:
                1000,
            lastCheckedHeight:
                0,
            accruedBudget:
                0
        });

        storage.saveCredit({
            minerAddress: A,
            blockHeight: 0,
            shares: 1,
            amount: 0.5,
            timestamp: 2000
        });

        const below =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            below.shouldRun,
            false
        );

        storage.saveCredit({
            minerAddress: A,
            blockHeight: 0,
            shares: 1,
            amount: 0.5,
            timestamp: 2001
        });

        const ready =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            ready.shouldRun,
            true
        );

        assert.equal(
            ready.currentReady,
            1
        );

        pass(
            "CURRENT_THRESHOLD_RESPECTED"
        );
    }
);


runCase(
    "legacy-block",
    (storage) => {
        const ledger =
            new PayoutLedger(
                storage
            );

        ledger.ensureState({
            cutoffTimestamp:
                5000,
            lastCheckedHeight:
                0,
            accruedBudget:
                0
        });

        storage.saveCredit({
            minerAddress: A,
            blockHeight: 0,
            shares: 1,
            amount: 5,
            timestamp: 1000
        });

        const before =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            before.shouldRun,
            false
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
            transactions: []
        });

        const after =
            getWakeState(
                storage,
                1,
                1
            );

        assert.equal(
            after.shouldRun,
            true
        );

        assert.equal(
            after.newLegacyBlocks,
            1
        );

        assert.equal(
            after.legacyReady,
            1
        );

        pass(
            "NEW_BLOCK_WAKES_LEGACY_BUDGET"
        );
    }
);


console.log("");
console.log(
    "RESULT PAYOUT WATCHER: 7/7 PASS"
);
