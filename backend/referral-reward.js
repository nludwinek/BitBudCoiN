"use strict";

const crypto = require("crypto");

const REFERRAL_REWARD_BBC = 2;
const REFERRAL_REWARD_CAP = 10;

class ReferralReward {
    constructor(
        storage,
        {
            rewardAmount = REFERRAL_REWARD_BBC,
            rewardCap = REFERRAL_REWARD_CAP
        } = {}
    ) {
        if (!storage || !storage.db) {
            throw new Error(
                "ReferralReward wymaga Storage z aktywna baza"
            );
        }

        if (
            typeof rewardAmount !== "number" ||
            !Number.isFinite(rewardAmount) ||
            !(rewardAmount > 0)
        ) {
            throw new Error(
                "rewardAmount musi byc dodatnia skonczona liczba"
            );
        }

        if (
            !Number.isInteger(rewardCap) ||
            rewardCap < 1
        ) {
            throw new Error(
                "rewardCap musi byc dodatnia liczba calkowita"
            );
        }

        this.storage = storage;
        this.db = storage.db;
        this.rewardAmount = rewardAmount;
        this.rewardCap = rewardCap;

        this._initSchema();
    }

    _initSchema() {
        /*
         * payout.js nie moze zalezec od efektu ubocznego require("./growth").
         * ReferralReward sam gwarantuje minimalny schemat, ktorego potrzebuje.
         */
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS growth_users (
                id TEXT PRIMARY KEY,
                wallet TEXT UNIQUE,
                referral_code TEXT UNIQUE,
                referred_by TEXT,
                created_at INTEGER,
                miners INTEGER DEFAULT 0,
                referrals INTEGER DEFAULT 0
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS growth_events (
                id TEXT PRIMARY KEY,
                type TEXT,
                timestamp INTEGER,
                data TEXT
            )
        `);

        try {
            this.db.exec(`
                ALTER TABLE growth_users
                ADD COLUMN rewarded_referrals INTEGER DEFAULT 0
            `);
        } catch (err) {
            if (
                !/duplicate column name/i.test(
                    String(
                        err &&
                        err.message
                    )
                )
            ) {
                throw err;
            }
        }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS growth_referral_rewards (
                referredWallet TEXT PRIMARY KEY,
                referrerId TEXT NOT NULL,
                referrerWallet TEXT NOT NULL,
                amount REAL NOT NULL,
                creditId INTEGER NOT NULL,
                eventId TEXT NOT NULL UNIQUE,
                createdAt INTEGER NOT NULL
            )
        `);

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS
            idx_growth_referral_rewards_referrer
            ON growth_referral_rewards(referrerId)
        `);
    }

    _transaction(fn) {
        this.db.exec(
            "BEGIN IMMEDIATE"
        );

        try {
            const result = fn();

            this.db.exec(
                "COMMIT"
            );

            return result;
        } catch (err) {
            try {
                this.db.exec(
                    "ROLLBACK"
                );
            } catch {}

            throw err;
        }
    }

    _eventId() {
        return (
            "evt_ref_" +
            crypto
                .randomBytes(16)
                .toString("hex")
        );
    }

    _getExisting(minerAddress) {
        return this.db.prepare(`
            SELECT
                referredWallet,
                referrerId,
                referrerWallet,
                amount,
                creditId,
                eventId,
                createdAt
            FROM growth_referral_rewards
            WHERE referredWallet = ?
        `).get(minerAddress) || null;
    }

    credit(minerAddress) {
        if (
            typeof minerAddress !== "string" ||
            !/^BbC[0-9a-fA-F]{40}$/.test(
                minerAddress
            )
        ) {
            throw new Error(
                "Nieprawidlowy adres poleconego"
            );
        }

        return this._transaction(() => {
            const existing =
                this._getExisting(
                    minerAddress
                );

            if (existing) {
                return {
                    credited: false,
                    reason:
                        "already-credited",
                    referrerWallet:
                        existing.referrerWallet,
                    amount:
                        Number(
                            existing.amount
                        ),
                    creditId:
                        Number(
                            existing.creditId
                        ),
                    eventId:
                        existing.eventId
                };
            }

            const referred =
                this.db.prepare(`
                    SELECT
                        id,
                        referred_by
                    FROM growth_users
                    WHERE wallet = ?
                `).get(minerAddress);

            if (
                !referred ||
                !referred.referred_by
            ) {
                return {
                    credited: false,
                    reason:
                        "not-referred"
                };
            }

            const referrer =
                this.db.prepare(`
                    SELECT
                        id,
                        wallet,
                        COALESCE(
                            rewarded_referrals,
                            0
                        ) AS rewarded_referrals
                    FROM growth_users
                    WHERE id = ?
                `).get(
                    referred.referred_by
                );

            if (!referrer) {
                return {
                    credited: false,
                    reason:
                        "referrer-missing"
                };
            }

            if (
                Number(
                    referrer.rewarded_referrals
                ) >= this.rewardCap
            ) {
                return {
                    credited: false,
                    reason:
                        "cap-reached",
                    referrerWallet:
                        referrer.wallet
                };
            }

            const tipRow =
                this.db.prepare(`
                    SELECT
                        COALESCE(
                            MAX(height),
                            0
                        ) AS height
                    FROM blocks
                `).get();

            const tip =
                Number(
                    tipRow.height
                );

            const now =
                Date.now();

            const counterUpdate =
                this.db.prepare(`
                    UPDATE growth_users
                    SET
                        rewarded_referrals =
                            COALESCE(
                                rewarded_referrals,
                                0
                            ) + 1
                    WHERE
                        id = ?
                        AND COALESCE(
                            rewarded_referrals,
                            0
                        ) < ?
                `).run(
                    referrer.id,
                    this.rewardCap
                );

            if (
                Number(
                    counterUpdate.changes
                ) !== 1
            ) {
                return {
                    credited: false,
                    reason:
                        "cap-reached",
                    referrerWallet:
                        referrer.wallet
                };
            }

            const creditResult =
                this.db.prepare(`
                    INSERT INTO pool_credits
                    (
                        minerAddress,
                        blockHeight,
                        shares,
                        amount,
                        timestamp
                    )
                    VALUES (?, ?, 0, ?, ?)
                `).run(
                    referrer.wallet,
                    tip,
                    this.rewardAmount,
                    now
                );

            const creditId =
                Number(
                    creditResult.lastInsertRowid
                );

            const eventId =
                this._eventId();

            this.db.prepare(`
                INSERT INTO growth_referral_rewards
                (
                    referredWallet,
                    referrerId,
                    referrerWallet,
                    amount,
                    creditId,
                    eventId,
                    createdAt
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                minerAddress,
                referrer.id,
                referrer.wallet,
                this.rewardAmount,
                creditId,
                eventId,
                now
            );

            this.db.prepare(`
                INSERT INTO growth_events
                (
                    id,
                    type,
                    timestamp,
                    data
                )
                VALUES (?, ?, ?, ?)
            `).run(
                eventId,
                "referral_reward_credited",
                now,
                JSON.stringify({
                    referred_wallet:
                        minerAddress,
                    referrer_wallet:
                        referrer.wallet,
                    amount:
                        this.rewardAmount,
                    credit_id:
                        creditId
                })
            );

            return {
                credited: true,
                reason: null,
                referrerWallet:
                    referrer.wallet,
                amount:
                    this.rewardAmount,
                creditId,
                eventId
            };
        });
    }

    getReward(minerAddress) {
        return this._getExisting(
            minerAddress
        );
    }
}

module.exports = {
    ReferralReward,
    REFERRAL_REWARD_BBC,
    REFERRAL_REWARD_CAP
};
