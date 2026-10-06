"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Storage = require("./storage");

const {
    ReferralReward
} = require("./referral-reward");

const dbPath = path.join(
    os.tmpdir(),
    "bbc-referral-" +
        process.pid +
        "-" +
        Date.now() +
        ".db"
);

const REFERRED =
    "BbC" + "a".repeat(40);

const REFERRED_2 =
    "BbC" + "b".repeat(40);

const REFERRED_NONE =
    "BbC" + "c".repeat(40);

const REFERRER =
    "BbC" + "d".repeat(40);

const REFERRER_CAP =
    "BbC" + "e".repeat(40);

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

function pass(name) {
    console.log(
        "PASS " + name
    );
}

function countCredits(
    storage,
    address
) {
    return storage.db.prepare(`
        SELECT COUNT(*) AS count
        FROM pool_credits
        WHERE minerAddress = ?
    `).get(address).count;
}

function totalCredits(
    storage,
    address
) {
    return Number(
        storage.db.prepare(`
            SELECT
                COALESCE(
                    SUM(amount),
                    0
                ) AS total
            FROM pool_credits
            WHERE minerAddress = ?
        `).get(address).total
    );
}

cleanup();

let storage = null;

try {
    storage =
        new Storage(dbPath);

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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "referrer-1",
        REFERRER,
        "REF001",
        null,
        Date.now(),
        0
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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "referred-1",
        REFERRED,
        "REF002",
        "referrer-1",
        Date.now(),
        0
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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "referred-2",
        REFERRED_2,
        "REF003",
        "referrer-1",
        Date.now(),
        0
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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "none-1",
        REFERRED_NONE,
        "REF004",
        null,
        Date.now(),
        0
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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "referrer-cap",
        REFERRER_CAP,
        "REF005",
        null,
        Date.now(),
        10
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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "cap-child",
        "BbC" + "f".repeat(40),
        "REF006",
        "referrer-cap",
        Date.now(),
        0
    );

    const referral =
        new ReferralReward(storage);


    const notReferred =
        referral.credit(
            REFERRED_NONE
        );

    assert.equal(
        notReferred.credited,
        false
    );

    assert.equal(
        notReferred.reason,
        "not-referred"
    );

    pass("NOT_REFERRED_NO_REWARD");


    const first =
        referral.credit(
            REFERRED
        );

    assert.equal(
        first.credited,
        true
    );

    assert.equal(
        first.referrerWallet,
        REFERRER
    );

    assert.equal(
        first.amount,
        2
    );

    assert.equal(
        countCredits(
            storage,
            REFERRER
        ),
        1
    );

    assert.equal(
        totalCredits(
            storage,
            REFERRER
        ),
        2
    );

    pass("FIRST_REWARD_CREDITED");


    const counter1 =
        storage.db.prepare(`
            SELECT rewarded_referrals
            FROM growth_users
            WHERE id = ?
        `).get(
            "referrer-1"
        );

    assert.equal(
        counter1.rewarded_referrals,
        1
    );

    pass("COUNTER_INCREMENTED_ONCE");


    const journal =
        referral.getReward(
            REFERRED
        );

    assert(journal);

    assert.equal(
        Number(journal.creditId),
        first.creditId
    );

    const event =
        storage.db.prepare(`
            SELECT *
            FROM growth_events
            WHERE id = ?
        `).get(
            first.eventId
        );

    assert(event);

    assert.equal(
        event.type,
        "referral_reward_credited"
    );

    pass("DURABLE_REWARD_JOURNAL");


    const retry =
        referral.credit(
            REFERRED
        );

    assert.equal(
        retry.credited,
        false
    );

    assert.equal(
        retry.reason,
        "already-credited"
    );

    assert.equal(
        retry.creditId,
        first.creditId
    );

    assert.equal(
        countCredits(
            storage,
            REFERRER
        ),
        1
    );

    const counter2 =
        storage.db.prepare(`
            SELECT rewarded_referrals
            FROM growth_users
            WHERE id = ?
        `).get(
            "referrer-1"
        );

    assert.equal(
        counter2.rewarded_referrals,
        1
    );

    pass("RETRY_IS_IDEMPOTENT");


    const second =
        referral.credit(
            REFERRED_2
        );

    assert.equal(
        second.credited,
        true
    );

    assert.equal(
        countCredits(
            storage,
            REFERRER
        ),
        2
    );

    assert.equal(
        totalCredits(
            storage,
            REFERRER
        ),
        4
    );

    const counter3 =
        storage.db.prepare(`
            SELECT rewarded_referrals
            FROM growth_users
            WHERE id = ?
        `).get(
            "referrer-1"
        );

    assert.equal(
        counter3.rewarded_referrals,
        2
    );

    pass("SECOND_DISTINCT_REFERRAL_REWARDED");


    const capped =
        referral.credit(
            "BbC" + "f".repeat(40)
        );

    assert.equal(
        capped.credited,
        false
    );

    assert.equal(
        capped.reason,
        "cap-reached"
    );

    assert.equal(
        countCredits(
            storage,
            REFERRER_CAP
        ),
        0
    );

    pass("CAP_BLOCKS_REWARD");


    const BEFORE_ROLLBACK_COUNT =
        countCredits(
            storage,
            REFERRER
        );

    const BEFORE_ROLLBACK_TOTAL =
        totalCredits(
            storage,
            REFERRER
        );

    const BEFORE_ROLLBACK_COUNTER =
        storage.db.prepare(`
            SELECT rewarded_referrals
            FROM growth_users
            WHERE id = ?
        `).get(
            "referrer-1"
        ).rewarded_referrals;


    storage.db.exec(`
        CREATE TRIGGER
        abort_referral_reward_journal
        BEFORE INSERT
        ON growth_referral_rewards
        WHEN NEW.referredWallet = '${"BbC" + "9".repeat(40)}'
        BEGIN
            SELECT RAISE(
                ABORT,
                'TEST_ATOMIC_ROLLBACK'
            );
        END
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
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        "rollback-child",
        "BbC" + "9".repeat(40),
        "REF009",
        "referrer-1",
        Date.now(),
        0
    );

    assert.throws(
        () =>
            referral.credit(
                "BbC" + "9".repeat(40)
            ),
        /TEST_ATOMIC_ROLLBACK/
    );

    assert.equal(
        countCredits(
            storage,
            REFERRER
        ),
        BEFORE_ROLLBACK_COUNT
    );

    assert.equal(
        totalCredits(
            storage,
            REFERRER
        ),
        BEFORE_ROLLBACK_TOTAL
    );

    assert.equal(
        storage.db.prepare(`
            SELECT rewarded_referrals
            FROM growth_users
            WHERE id = ?
        `).get(
            "referrer-1"
        ).rewarded_referrals,
        BEFORE_ROLLBACK_COUNTER
    );

    assert.equal(
        referral.getReward(
            "BbC" + "9".repeat(40)
        ),
        null
    );

    pass("FAILURE_ROLLS_BACK_ALL_WRITES");


    const secondStorage =
        new Storage(dbPath);

    const secondReferral =
        new ReferralReward(
            secondStorage
        );

    const restartRetry =
        secondReferral.credit(
            REFERRED
        );

    assert.equal(
        restartRetry.credited,
        false
    );

    assert.equal(
        restartRetry.reason,
        "already-credited"
    );

    assert.equal(
        countCredits(
            secondStorage,
            REFERRER
        ),
        2
    );

    secondStorage.close();

    pass("IDEMPOTENCY_SURVIVES_RESTART");


    const rewardsCount =
        storage.db.prepare(`
            SELECT COUNT(*) AS count
            FROM growth_referral_rewards
        `).get().count;

    assert.equal(
        rewardsCount,
        2
    );

    const eventsCount =
        storage.db.prepare(`
            SELECT COUNT(*) AS count
            FROM growth_events
            WHERE type =
                'referral_reward_credited'
        `).get().count;

    assert.equal(
        eventsCount,
        2
    );

    pass("ONE_JOURNAL_AND_EVENT_PER_REWARD");


    console.log("");
    console.log(
        "RESULT REFERRAL: 10/10 PASS"
    );
} finally {
    if (storage) {
        try {
            storage.close();
        } catch {}
    }

    cleanup();
}
