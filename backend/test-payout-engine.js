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

const {
    deriveAddress
} = require("./wallet");

const PayoutLedger =
    require("./payout-ledger");

const {
    ReferralReward
} = require("./referral-reward");

const {
    PayoutEngine
} = require("./payout-engine");

const dbPath =
    path.join(
        os.tmpdir(),
        "bbc-payout-engine-" +
            process.pid +
            "-" +
            Date.now() +
            ".db"
    );

const A =
    "BbC" + "a".repeat(40);

const B =
    "BbC" + "b".repeat(40);

const C =
    "BbC" + "c".repeat(40);

const D =
    "BbC" + "d".repeat(40);

const REFERRER =
    "BbC" + "e".repeat(40);

function pass(name) {
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

function saveCredit(
    storage,
    minerAddress,
    amount,
    timestamp,
    height = 0
) {
    storage.saveCredit({
        minerAddress,
        blockHeight:
            height,
        shares: 1,
        amount,
        timestamp
    });
}

function makeBlock(
    height,
    tx
) {
    return {
        height,
        timestamp:
            tx.timestamp,
        previousHash:
            String(
                height - 1
            ).padStart(
                64,
                "0"
            ),
        hash:
            String(
                height
            ).padStart(
                64,
                "1"
            ).slice(
                0,
                64
            ),
        nonce: 0,
        difficulty: 1,
        transactions: [
            {
                ...tx,
                type:
                    "transfer"
            }
        ]
    };
}

cleanup();

let storage = null;

(async () => {
    try {
        storage =
            new Storage(
                dbPath
            );

        storage.db.exec(`
            CREATE TABLE growth_users (
                id TEXT PRIMARY KEY,
                wallet TEXT UNIQUE,
                referral_code TEXT UNIQUE,
                referred_by TEXT,
                created_at INTEGER,
                miners INTEGER DEFAULT 0,
                referrals INTEGER DEFAULT 0,
                rewarded_referrals INTEGER DEFAULT 0
            )
        `);

        storage.db.exec(`
            CREATE TABLE growth_events (
                id TEXT PRIMARY KEY,
                type TEXT,
                timestamp INTEGER,
                data TEXT
            )
        `);

        storage.db.prepare(`
            INSERT INTO growth_users
            (
                id,
                wallet,
                referral_code,
                referred_by,
                created_at,
                rewarded_referrals
            )
            VALUES (?, ?, ?, ?, ?, 0)
        `).run(
            "referrer",
            REFERRER,
            "REF001",
            null,
            Date.now()
        );

        storage.db.prepare(`
            INSERT INTO growth_users
            (
                id,
                wallet,
                referral_code,
                referred_by,
                created_at,
                rewarded_referrals
            )
            VALUES (?, ?, ?, ?, ?, 0)
        `).run(
            "miner-a",
            A,
            "REF002",
            "referrer",
            Date.now()
        );

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


        const submitted1 = [];

        const engine1 =
            new PayoutEngine({
                storage,
                privateKey:
                    privatePem,
                publicKey:
                    publicPem,
                poolAddress,
                serverUrl:
                    "http://test",
                fee: 0.01,
                minPayout: 1,
                maxSinglePayout:
                    100,
                delayMs: 0,
                submitFn:
                    async (
                        candidate
                    ) => {
                        submitted1.push(
                            JSON.parse(
                                JSON.stringify(
                                    candidate
                                )
                            )
                        );

                        storage
                            .saveMempoolTx({
                                ...candidate,
                                receivedAt:
                                    Date.now()
                            });

                        throw new Error(
                            "TEST_RESPONSE_LOST"
                        );
                    }
            });

        const first =
            await engine1
                .submitCurrent(
                    A,
                    1000
                );

        assert.equal(
            first.status,
            "pending"
        );

        assert.equal(
            submitted1.length,
            1
        );

        const active1 =
            ledger
                .getActiveBatches();

        assert.equal(
            active1.length,
            1
        );

        assert.equal(
            active1[0].state,
            "submitted"
        );

        assert(
            active1[0]
                .txSignature
        );

        pass(
            "LOST_RESPONSE_PERSISTS_SUBMITTED"
        );


        let unexpectedRetry =
            0;

        const engine2 =
            new PayoutEngine({
                storage,
                privateKey:
                    privatePem,
                publicKey:
                    publicPem,
                poolAddress,
                serverUrl:
                    "http://test",
                fee: 0.01,
                minPayout: 1,
                maxSinglePayout:
                    100,
                delayMs: 0,
                submitFn:
                    async () => {
                        unexpectedRetry++;
                        throw new Error(
                            "SHOULD_NOT_SEND_PENDING"
                        );
                    }
            });

        const recoveredPending =
            await engine2
                .recoverActive();

        assert.equal(
            unexpectedRetry,
            0
        );

        assert.equal(
            recoveredPending[0]
                .status,
            "pending"
        );

        pass(
            "RESTART_DOES_NOT_DUPLICATE_PENDING"
        );


        const firstCandidate =
            active1[0]
                .candidate;

        storage.deleteMempoolTx(
            firstCandidate.signature
        );

        storage.saveBlock(
            makeBlock(
                1,
                firstCandidate
            )
        );

        const recoveredConfirmed =
            await engine2
                .recoverActive();

        assert.equal(
            recoveredConfirmed[0]
                .status,
            "confirmed"
        );

        const creditsA =
            storage.db.prepare(`
                SELECT paid
                FROM pool_credits
                WHERE minerAddress = ?
                ORDER BY id
            `).all(A);

        assert.deepEqual(
            creditsA.map(
                (r) => r.paid
            ),
            [1, 1]
        );

        pass(
            "CONFIRMED_SIGNATURE_FINALIZES"
        );


        /*
         * Symulacja crasha:
         * reward zostal atomowo naliczony,
         * ale payout ledger nie zdazyl ustawic
         * referralProcessed.
         */
        const referral =
            new ReferralReward(
                storage
            );

        const rewardFirst =
            referral.credit(A);

        assert.equal(
            rewardFirst.credited,
            true
        );

        assert.equal(
            ledger
                .getReferralPending()
                .length,
            1
        );

        const referralRecovery =
            await engine2
                .processReferralPending();

        assert.equal(
            referralRecovery.length,
            1
        );

        assert.equal(
            referralRecovery[0]
                .reward.reason,
            "already-credited"
        );

        assert.equal(
            ledger
                .getReferralPending()
                .length,
            0
        );

        assert.equal(
            storage.db.prepare(`
                SELECT COUNT(*) AS n
                FROM pool_credits
                WHERE
                    minerAddress = ?
                    AND shares = 0
                    AND amount = 2
            `).get(
                REFERRER
            ).n,
            1
        );

        pass(
            "REFERRAL_CRASH_RETRY_IDEMPOTENT"
        );


        saveCredit(
            storage,
            B,
            4,
            2100
        );

        const rejectEngine =
            new PayoutEngine({
                storage,
                privateKey:
                    privatePem,
                publicKey:
                    publicPem,
                poolAddress,
                serverUrl:
                    "http://test",
                fee: 0.01,
                minPayout: 1,
                maxSinglePayout:
                    100,
                delayMs: 0,
                submitFn:
                    async () => ({
                        kind:
                            "rejected",
                        status: 400,
                        reason:
                            "Niewystarczajace saldo",
                        data: {
                            accepted:
                                false
                        }
                    })
            });

        const rejected =
            await rejectEngine
                .submitCurrent(
                    B,
                    1000
                );

        /*
         * HTTP rejection NIE jest dowodem finalnym.
         *
         * Candidate jest juz podpisany i batch submitted,
         * dlatego credits musza pozostac przypiete do TEGO
         * samego batcha.
         */
        assert.equal(
            rejected.status,
            "submitted"
        );

        assert.equal(
            rejected.outcome.kind,
            "rejected"
        );

        const heldB =
            ledger
                .getActiveBatches()
                .find(
                    (b) =>
                        b.minerAddress ===
                        B
                );

        assert.ok(
            heldB
        );

        assert.equal(
            heldB.state,
            "submitted"
        );

        assert.ok(
            heldB.txSignature
        );

        assert.ok(
            heldB.candidate
        );

        const creditB =
            storage.db.prepare(`
                SELECT
                    paid,
                    payoutBatchId
                FROM pool_credits
                WHERE minerAddress = ?
            `).get(B);

        assert.equal(
            creditB.paid,
            0
        );

        assert.equal(
            creditB.payoutBatchId,
            heldB.batchId
        );

        pass(
            "HTTP_REJECTION_HOLDS_SIGNED_CREDITS"
        );

        /*
         * Tylko porzadkowanie stanu TEGO testu.
         *
         * To jest jawne, bezposrednie wywolanie ledger API,
         * nie automatyczna decyzja na podstawie HTTP.
         * Potrzebne, zeby kolejne scenariusze w tym samym
         * pliku zaczynaly bez aktywnego batcha B.
         */
        const cleanedB =
            ledger.rejectSubmitted(
                heldB.batchId,
                "TEST_CLEANUP_ONLY"
            );

        assert.equal(
            cleanedB.state,
            "failed"
        );

        const cleanedCreditB =
            storage.db.prepare(`
                SELECT
                    paid,
                    payoutBatchId
                FROM pool_credits
                WHERE minerAddress = ?
            `).get(B);

        assert.equal(
            cleanedCreditB.paid,
            0
        );

        assert.equal(
            cleanedCreditB.payoutBatchId,
            null
        );


        saveCredit(
            storage,
            C,
            5,
            2200
        );

        const unknownSent = [];

        const unknownEngine =
            new PayoutEngine({
                storage,
                privateKey:
                    privatePem,
                publicKey:
                    publicPem,
                poolAddress,
                serverUrl:
                    "http://test",
                fee: 0.01,
                minPayout: 1,
                maxSinglePayout:
                    100,
                delayMs: 0,
                submitFn:
                    async (
                        candidate
                    ) => {
                        unknownSent.push(
                            candidate
                        );

                        throw new Error(
                            "NETWORK_UNKNOWN"
                        );
                    }
            });

        const unknownResult =
            await unknownEngine
                .submitCurrent(
                    C,
                    1000
                );

        assert.equal(
            unknownResult.status,
            "submitted"
        );

        const heldC =
            ledger
                .getActiveBatches()
                .find(
                    (b) =>
                        b.minerAddress ===
                        C
                );

        assert(heldC);

        assert.equal(
            heldC.state,
            "submitted"
        );

        assert.equal(
            storage.db.prepare(`
                SELECT payoutBatchId
                FROM pool_credits
                WHERE minerAddress = ?
            `).get(C)
                .payoutBatchId,
            heldC.batchId
        );

        pass(
            "UNKNOWN_RESPONSE_HOLDS_CREDITS"
        );


        const retrySent = [];

        const retryEngine =
            new PayoutEngine({
                storage,
                privateKey:
                    privatePem,
                publicKey:
                    publicPem,
                poolAddress,
                serverUrl:
                    "http://test",
                fee: 0.01,
                minPayout: 1,
                maxSinglePayout:
                    100,
                delayMs: 0,
                submitFn:
                    async (
                        candidate
                    ) => {
                        retrySent.push(
                            candidate
                        );

                        storage
                            .saveMempoolTx({
                                ...candidate,
                                receivedAt:
                                    Date.now()
                            });

                        return {
                            kind:
                                "accepted",
                            status: 200,
                            reason: "",
                            data: {
                                accepted:
                                    true,
                                signature:
                                    candidate.signature
                            }
                        };
                    }
            });

        const retried =
            await retryEngine
                .recoverActive();

        const retriedC =
            retried.find(
                (r) =>
                    r.batch &&
                    r.batch
                        .minerAddress ===
                        C
            );

        assert(retriedC);

        assert.equal(
            retriedC.status,
            "pending"
        );

        assert.equal(
            retrySent.length,
            1
        );

        assert.equal(
            retrySent[0]
                .signature,
            unknownSent[0]
                .signature
        );

        assert.equal(
            retrySent[0]
                .timestamp,
            unknownSent[0]
                .timestamp
        );

        assert.deepEqual(
            retrySent[0],
            unknownSent[0]
        );

        pass(
            "RETRY_REUSES_EXACT_CANDIDATE"
        );


        storage.deleteMempoolTx(
            retrySent[0]
                .signature
        );

        storage.saveBlock(
            makeBlock(
                2,
                retrySent[0]
            )
        );

        const retryConfirmed =
            await retryEngine
                .recoverActive();

        const confirmedC =
            retryConfirmed.find(
                (r) =>
                    r.batch &&
                    r.batch
                        .minerAddress ===
                        C
            );

        assert(confirmedC);

        assert.equal(
            confirmedC.status,
            "confirmed"
        );

        assert.equal(
            storage.db.prepare(`
                SELECT paid
                FROM pool_credits
                WHERE minerAddress = ?
            `).get(C).paid,
            1
        );

        pass(
            "RETRIED_SIGNATURE_FINALIZES"
        );


        saveCredit(
            storage,
            D,
            500,
            2300
        );

        let maxSubmitCalls =
            0;

        const maxEngine =
            new PayoutEngine({
                storage,
                privateKey:
                    privatePem,
                publicKey:
                    publicPem,
                poolAddress,
                serverUrl:
                    "http://test",
                fee: 0.01,
                minPayout: 1,
                maxSinglePayout:
                    100,
                delayMs: 0,
                submitFn:
                    async () => {
                        maxSubmitCalls++;
                        throw new Error(
                            "MAX_GUARD_FAILED"
                        );
                    }
            });

        await assert.rejects(
            () =>
                maxEngine
                    .submitCurrent(
                        D,
                        1000
                    ),
            /MAX_SINGLE_PAYOUT/
        );

        assert.equal(
            maxSubmitCalls,
            0
        );

        const creditD =
            storage.db.prepare(`
                SELECT
                    paid,
                    payoutBatchId
                FROM pool_credits
                WHERE minerAddress = ?
            `).get(D);

        assert.equal(
            creditD.paid,
            0
        );

        assert.equal(
            creditD.payoutBatchId,
            null
        );

        pass(
            "MAX_PAYOUT_GUARD_FAILS_STOP"
        );


        console.log("");
        console.log(
            "RESULT PAYOUT ENGINE: 9/9 PASS"
        );
    } finally {
        if (storage) {
            try {
                storage.close();
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
