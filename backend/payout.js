"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Storage = require("./storage");
const CONFIG = require("./config");

const {
    deriveAddress
} = require("./wallet");

const {
    PayoutEngine
} = require("./payout-engine");

const {
    PayoutStateMigration
} = require("./payout-state-migration");


const LEGACY_STATE_PATH =
    path.join(
        __dirname,
        "legacy-debt-state.json"
    );

const LEGACY_SHARE = 0.10;

const MIN_LEGACY_PAYOUT =
    0.01;

const DELAY_BETWEEN_SENDS_MS =
    1200;

const MAX_PAYOUT_MULTIPLIER =
    200;


function rewardForHeight(height) {
    return (
        CONFIG.BLOCK_REWARD /
        Math.pow(
            2,
            Math.floor(
                height /
                CONFIG.HALVING_INTERVAL
            )
        )
    );
}


function parseMinPayout(value) {
    if (value === undefined) {
        return 1;
    }

    const parsed =
        Number(value);

    if (
        !Number.isFinite(parsed) ||
        parsed < 0
    ) {
        return 1;
    }

    return parsed;
}


function isLoopbackServerUrl(value) {
    let parsed;

    try {
        parsed =
            new URL(
                String(value)
            );
    } catch {
        return false;
    }

    if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:"
    ) {
        return false;
    }

    const hostname =
        parsed.hostname
            .toLowerCase();

    if (
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname === "[::1]"
    ) {
        return true;
    }

    const ipv4 =
        hostname.match(
            /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
        );

    if (!ipv4) {
        return false;
    }

    const octets =
        ipv4
            .slice(1)
            .map(Number);

    if (
        octets.some(
            (part) =>
                !Number.isInteger(part) ||
                part < 0 ||
                part > 255
        )
    ) {
        return false;
    }

    return octets[0] === 127;
}


function logCycle(result) {
    const migration =
        result.migration;

    const cycle =
        result.cycle;

    console.log(
        "[payout] state source: " +
        migration.source +
        ", cutoff=" +
        migration.state
            .cutoffTimestamp +
        ", lastHeight=" +
        migration.state
            .lastCheckedHeight +
        ", legacyBudget=" +
        Number(
            migration.state
                .accruedBudget
        ).toFixed(8)
    );

    if (
        cycle.budget &&
        cycle.budget.advanced
    ) {
        console.log(
            "[payout] legacy budget +" +
            Number(
                cycle.budget.added
            ).toFixed(8) +
            " BbC from " +
            cycle.budget.blocks +
            " new blocks"
        );
    }

    for (
        const item of
        cycle.recovered || []
    ) {
        console.log(
            "[payout] recovered " +
            item.batch.batchId +
            " -> " +
            item.status
        );
    }

    for (
        const item of
        cycle.currentResults || []
    ) {
        console.log(
            "[payout] current " +
            item.minerAddress +
            " -> " +
            item.result.status
        );
    }

    if (cycle.legacyResult) {
        console.log(
            "[payout] legacy -> " +
            cycle.legacyResult.status
        );
    }

    const referrals = [
        ...(cycle.referralsBefore || []),
        ...(cycle.referralsAfter || [])
    ];

    for (
        const item of referrals
    ) {
        console.log(
            "[payout] referral " +
            item.minerAddress +
            " -> " +
            (
                item.reward.credited
                    ? "credited"
                    : item.reward.reason
            )
        );
    }
}


async function main(
    privateKeyPath,
    serverUrl,
    minPayout,
    options = {}
) {
    if (
        typeof privateKeyPath !==
            "string" ||
        privateKeyPath.length === 0
    ) {
        throw new Error(
            "Brak sciezki do klucza puli"
        );
    }

    const privateKey =
        fs.readFileSync(
            privateKeyPath,
            "utf8"
        );

    const publicKey =
        crypto
            .createPublicKey(
                privateKey
            )
            .export({
                type: "spki",
                format: "pem"
            });

    const poolAddress =
        deriveAddress(
            publicKey
        );

    const expectedPoolAddress =
        options.expectedPoolAddress ??
        CONFIG.POOL_ADDRESS;

    if (
        poolAddress !==
        expectedPoolAddress
    ) {
        throw new Error(
            "STOP: klucz nie pasuje do POOL_ADDRESS"
        );
    }

    const databasePath =
        options.databasePath ??
        CONFIG.DATABASE;

    const statePath =
        options.statePath ??
        LEGACY_STATE_PATH;

    const resolvedServerUrl =
        serverUrl ||
        `http://localhost:${CONFIG.API_PORT}`;

    /*
     * Idempotent recovery rozstrzyga stan transakcji na podstawie
     * TEJ SAMEJ lokalnej bazy SQLite co node.
     *
     * Dlatego prawdziwy HTTP payout musi isc do lokalnego noda.
     * Testy moga wstrzyknac submitFn i wtedy sieci w ogole nie uzywamy.
     */
    if (
        typeof options.submitFn !== "function" &&
        !isLoopbackServerUrl(
            resolvedServerUrl
        )
    ) {
        throw new Error(
            "STOP: payout HTTP wymaga lokalnego wezla; " +
            "zdalny serverUrl nie daje bezpiecznego lokalnego reconciliation"
        );
    }

    const payoutMinimum =
        parseMinPayout(
            minPayout
        );

    const maxSinglePayout =
        CONFIG.BLOCK_REWARD *
        MAX_PAYOUT_MULTIPLIER;

    let storage = null;

    try {
        storage =
            new Storage(
                databasePath
            );

        /*
         * Pierwsze uruchomienie po upgrade:
         * zachowuje DOKLADNIE cutoffTimestamp,
         * lastCheckedHeight i accruedBudget
         * ze starego legacy-debt-state.json.
         *
         * Po migracji SQLite jest zrodlem prawdy.
         */
        const migration =
            new PayoutStateMigration(
                storage,
                {
                    statePath,
                    now:
                        options.now
                }
            ).migrate();

        const engine =
            new PayoutEngine({
                storage,
                privateKey,
                publicKey,
                poolAddress,
                serverUrl:
                    resolvedServerUrl,
                fee:
                    CONFIG.MIN_FEE,
                minPayout:
                    payoutMinimum,
                maxSinglePayout,
                submitFn:
                    options.submitFn,
                now:
                    options.now,
                sleepFn:
                    options.sleepFn,
                delayMs:
                    options.delayMs ??
                    DELAY_BETWEEN_SENDS_MS
            });

        const cycle =
            await engine.runCycle({
                cutoffTimestamp:
                    migration.state
                        .cutoffTimestamp,
                rewardForHeight,
                legacyShare:
                    LEGACY_SHARE,
                minLegacyPayout:
                    MIN_LEGACY_PAYOUT
            });

        const result = {
            migration,
            cycle
        };

        if (
            options.log !== false
        ) {
            logCycle(
                result
            );
        }

        return result;
    } finally {
        if (storage) {
            storage.close();
        }
    }
}


if (require.main === module) {
    const privateKeyPath =
        process.argv[2];

    const serverUrl =
        process.argv[3] ||
        `http://localhost:${CONFIG.API_PORT}`;

    const minPayout =
        parseMinPayout(
            process.argv[4]
        );

    if (!privateKeyPath) {
        console.error(
            "Uzycie: node payout.js <klucz_puli.pem> [url] [min_wyplata]"
        );

        process.exit(1);
    }

    main(
        privateKeyPath,
        serverUrl,
        minPayout
    ).catch(
        (err) => {
            console.error(
                "[payout] STOP:",
                err
            );

            process.exit(1);
        }
    );
}


module.exports = {
    main,
    rewardForHeight,
    parseMinPayout,
    LEGACY_STATE_PATH,
    LEGACY_SHARE,
    MIN_LEGACY_PAYOUT,
    MAX_PAYOUT_MULTIPLIER,
    isLoopbackServerUrl
};
