"use strict";

const assert = require("assert");
const MiningPool = require("./pool");
const {
    computeBlockHash
} = require("./bbcblockchain");

const POOL =
    "BbC" + "1".repeat(40);

const MINER =
    "BbC" + "2".repeat(40);

const OTHER_MINER =
    "BbC" + "3".repeat(40);

const BLOCK_DIFFICULTY = 1024;
const SHARE_DIFFICULTY_EXPONENT = 1;
const SHARE_DIFFICULTY = 16;
const POOL_FEE = 0.02;
const REWARD = 50;

function makeEnvironment() {
    const credits = [];
    const receivedBlocks = [];

    const blockchain = {
        difficulty: BLOCK_DIFFICULTY,

        chain: [
            {
                height: 99,
                hash: "9".repeat(64)
            },
            {
                height: 100,
                hash: "a".repeat(64)
            }
        ],

        getLatestBlock() {
            return this.chain[this.chain.length - 1];
        },

        buildBlockTransactions(poolAddress, pending) {
            return [
                {
                    type: "coinbase",
                    to: poolAddress,
                    amount: REWARD
                },
                ...(pending || [])
            ];
        },

        getRewardForHeight() {
            return REWARD;
        },

        saveCredit(row) {
            credits.push({ ...row });
        },

        receiveBlock(candidate) {
            receivedBlocks.push(candidate);

            return {
                accepted: true,
                block: { ...candidate }
            };
        },

        getCredits(minerAddress) {
            return credits.filter(
                (x) => x.minerAddress === minerAddress
            );
        }
    };

    const pool = new MiningPool(
        blockchain,
        {
            poolAddress: POOL,
            poolFee: POOL_FEE,
            shareDifficulty: SHARE_DIFFICULTY_EXPONENT,
            mempool: null
        }
    );

    return {
        pool,
        blockchain,
        credits,
        receivedBlocks
    };
}

function candidateFor(work, nonce, overrides = {}) {
    const candidate = {
        height: work.height,
        previousHash: work.previousHash,
        timestamp: work.timestamp,
        transactions:
            JSON.parse(JSON.stringify(work.transactions)),
        difficulty: work.difficulty,
        nonce,
        ...overrides
    };

    candidate.hash = computeBlockHash(candidate);

    return candidate;
}

function findCandidate(work, predicate, max = 2_000_000) {
    for (let nonce = 0; nonce < max; nonce++) {
        const candidate = candidateFor(work, nonce);

        if (predicate(candidate.hash, candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Nie znaleziono odpowiedniego nonce po ${max} probach`
    );
}

function mineOrdinaryShare(work, excludedHash = null) {
    return findCandidate(
        work,
        (hash) =>
            hash <= work.shareTarget &&
            hash > work.blockTarget &&
            hash !== excludedHash
    );
}

function almostEqual(a, b, epsilon = 1e-12) {
    return Math.abs(a - b) <= epsilon;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`PASS ${name}`);
    } catch (err) {
        failed++;
        console.error(`FAIL ${name}`);
        console.error(`     ${err.message}`);
    }
}

/* ---------------------------------------------------------
   1. UNKNOWN_JOB / fail closed
--------------------------------------------------------- */

test("UNKNOWN_JOB", () => {
    const { pool } = makeEnvironment();

    const work = pool.getWork(MINER);
    const candidate = mineOrdinaryShare(work);

    const missing =
        pool.submitShare(
            MINER,
            candidate,
            undefined
        );

    assert.strictEqual(missing.accepted, false);
    assert.strictEqual(missing.code, "UNKNOWN_JOB");

    const malformed =
        pool.submitShare(
            MINER,
            candidate,
            "abc"
        );

    assert.strictEqual(malformed.accepted, false);
    assert.strictEqual(malformed.code, "UNKNOWN_JOB");

    const random =
        pool.submitShare(
            MINER,
            candidate,
            "f".repeat(32)
        );

    assert.strictEqual(random.accepted, false);
    assert.strictEqual(random.code, "UNKNOWN_JOB");
});

/* ---------------------------------------------------------
   2. WRONG_MINER
--------------------------------------------------------- */

test("WRONG_MINER", () => {
    const { pool } = makeEnvironment();

    const work = pool.getWork(MINER);
    const candidate = mineOrdinaryShare(work);

    const result =
        pool.submitShare(
            OTHER_MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.code, "WRONG_MINER");
});

/* ---------------------------------------------------------
   3. CLIENT_TEMPLATE_TAMPERING
--------------------------------------------------------- */

test("CLIENT_TEMPLATE_TAMPERING", () => {
    const { pool } = makeEnvironment();

    const work = pool.getWork(MINER);
    const normal = mineOrdinaryShare(work);

    const tampered = candidateFor(
        work,
        normal.nonce,
        {
            timestamp: work.timestamp + 1
        }
    );

    const result =
        pool.submitShare(
            MINER,
            tampered,
            work.workId
        );

    assert.strictEqual(result.accepted, false);
    assert.strictEqual(
        result.code,
        "INVALID_JOB_DATA"
    );
});

/* ---------------------------------------------------------
   4. CLIENT_TARGET_TAMPERING
--------------------------------------------------------- */

test("CLIENT_TARGET_TAMPERING", () => {
    const { pool } = makeEnvironment();

    const work = pool.getWork(MINER);

    /*
     * Klient może sobie lokalnie udawać shareTarget = ffff...
     * ale serwer ma własny immutable target w workJobs.
     */
    const candidate = findCandidate(
        work,
        (hash) => hash > work.shareTarget
    );

    const result =
        pool.submitShare(
            MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(result.accepted, false);
    assert.strictEqual(
        result.code,
        "LOW_DIFFICULTY_SHARE"
    );
});

/* ---------------------------------------------------------
   5. SAME_WALLET_TWO_MINERS
--------------------------------------------------------- */

test("SAME_WALLET_TWO_MINERS", () => {
    const { pool } = makeEnvironment();

    const workA = pool.getWork(MINER);

    pool.minerDifficulty.set(
        MINER,
        64
    );

    const workB = pool.getWork(MINER);

    assert.notStrictEqual(
        workA.workId,
        workB.workId
    );

    assert.notStrictEqual(
        workA.shareTarget,
        workB.shareTarget
    );

    assert.strictEqual(
        pool.workJobs.has(workA.workId),
        true
    );

    assert.strictEqual(
        pool.workJobs.has(workB.workId),
        true
    );

    const shareA = mineOrdinaryShare(workA);
    const shareB = mineOrdinaryShare(
        workB,
        shareA.hash
    );

    const resultA =
        pool.submitShare(
            MINER,
            shareA,
            workA.workId
        );

    const resultB =
        pool.submitShare(
            MINER,
            shareB,
            workB.workId
        );

    assert.strictEqual(resultA.accepted, true);
    assert.strictEqual(resultB.accepted, true);
});

/* ---------------------------------------------------------
   6. JOB_DIFFICULTY_IMMUTABLE
--------------------------------------------------------- */

test("JOB_DIFFICULTY_IMMUTABLE", () => {
    const { pool } = makeEnvironment();

    const oldWork = pool.getWork(MINER);

    pool.minerDifficulty.set(
        MINER,
        256
    );

    const newWork = pool.getWork(MINER);

    assert.notStrictEqual(
        oldWork.shareTarget,
        newWork.shareTarget
    );

    /*
     * Szukamy hasha:
     *
     * - wystarczającego dla STAREGO joba,
     * - niewystarczającego dla NOWEGO targetu.
     */
    const candidate = findCandidate(
        oldWork,
        (hash) =>
            hash <= oldWork.shareTarget &&
            hash > newWork.shareTarget
    );

    const result =
        pool.submitShare(
            MINER,
            candidate,
            oldWork.workId
        );

    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.share, true);
});

/* ---------------------------------------------------------
   7. DUPLICATE_SHARE
--------------------------------------------------------- */

test("DUPLICATE_SHARE", () => {
    const { pool } = makeEnvironment();

    const work = pool.getWork(MINER);
    const candidate = mineOrdinaryShare(work);

    const first =
        pool.submitShare(
            MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(first.accepted, true);

    const second =
        pool.submitShare(
            MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(second.accepted, false);
    assert.strictEqual(
        second.code,
        "DUPLICATE_SHARE"
    );
});

/* ---------------------------------------------------------
   8. STALE_JOB_TTL
--------------------------------------------------------- */

test("STALE_JOB_TTL", () => {
    const { pool } = makeEnvironment();

    const work = pool.getWork(MINER);
    const candidate = mineOrdinaryShare(work);

    const original =
        pool.workJobs.get(work.workId);

    pool.workJobs.set(
        work.workId,
        {
            ...original,
            createdAt:
                Date.now() - (10 * 60 * 1000)
        }
    );

    const result =
        pool.submitShare(
            MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.code, "STALE_JOB");

    assert.strictEqual(
        pool.workJobs.has(work.workId),
        false
    );
});

/* ---------------------------------------------------------
   9. STALE_CHAIN_JOB
--------------------------------------------------------- */

test("STALE_CHAIN_JOB", () => {
    const {
        pool,
        blockchain
    } = makeEnvironment();

    const work = pool.getWork(MINER);
    const candidate = mineOrdinaryShare(work);

    /*
     * Stary previousHash staje się dziadkiem,
     * nie tipem ani rodzicem.
     */
    blockchain.chain.push({
        height: 101,
        hash: "b".repeat(64)
    });

    blockchain.chain.push({
        height: 102,
        hash: "c".repeat(64)
    });

    const result =
        pool.submitShare(
            MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.code, "STALE_JOB");
});

/* ---------------------------------------------------------
   10. JOB_STORAGE_LIMIT
--------------------------------------------------------- */

test("JOB_STORAGE_LIMIT", () => {
    const { pool } = makeEnvironment();

    pool.workJobs.clear();

    const now = Date.now();

    for (let i = 0; i < 10005; i++) {
        const id =
            String(i).padStart(32, "0");

        pool.workJobs.set(
            id,
            {
                createdAt: now
            }
        );
    }

    const oldest =
        String(0).padStart(32, "0");

    const newest =
        String(10004).padStart(32, "0");

    pool._enforceWorkJobLimit();

    assert.strictEqual(
        pool.workJobs.size,
        10000
    );

    assert.strictEqual(
        pool.workJobs.has(oldest),
        false
    );

    assert.strictEqual(
        pool.workJobs.has(newest),
        true
    );
});

/* ---------------------------------------------------------
   11. CREDIT_USES_JOB_DIFFICULTY
--------------------------------------------------------- */

test("CREDIT_USES_JOB_DIFFICULTY", () => {
    const {
        pool,
        blockchain,
        credits
    } = makeEnvironment();

    const work = pool.getWork(MINER);
    const candidate = mineOrdinaryShare(work);

    /*
     * Symulujemy zmianę trudności sieci PO wydaniu joba.
     * Nie może to zmienić wartości starego share.
     */
    blockchain.difficulty = 1_000_000;

    const result =
        pool.submitShare(
            MINER,
            candidate,
            work.workId
        );

    assert.strictEqual(result.accepted, true);
    assert.strictEqual(credits.length, 1);

    const maxShareValue =
        REWARD * (1 - POOL_FEE);

    const effectiveMinerDiff =
        Math.min(
            SHARE_DIFFICULTY,
            BLOCK_DIFFICULTY * 0.25
        );

    const expected =
        maxShareValue *
        (
            effectiveMinerDiff /
            BLOCK_DIFFICULTY
        );

    assert(
        almostEqual(
            credits[0].amount,
            expected
        ),
        `credit=${credits[0].amount}, expected=${expected}`
    );

    assert.strictEqual(
        credits[0].blockHeight,
        work.height
    );

    assert(
        almostEqual(
            result.paidNow,
            expected
        )
    );
});

console.log("");
console.log(
    `RESULT: ${passed}/${passed + failed} PASS`
);

if (failed > 0) {
    process.exit(1);
}
