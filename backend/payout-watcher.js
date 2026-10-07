"use strict";

/*
 * payout-watcher.js
 *
 * Watcher nie decyduje juz tylko na podstawie paid=0.
 *
 * Musi obudzic payout.js rowniez wtedy, gdy:
 * - istnieje aktywny reserved/submitted payout wymagajacy recovery,
 * - potwierdzony payout czeka tylko na referral,
 * - istnieje legacy debt i pojawily sie nowe bloki do naliczenia budzetu.
 *
 * Sam watcher NIE wysyla transakcji.
 */

const CONFIG = require("./config");
const Storage = require("./storage");
const PayoutLedger = require("./payout-ledger");

const {
    execFile
} = require("child_process");

const path = require("path");

const {
    MIN_LEGACY_PAYOUT
} = require("./payout");


const ADDRESS_FORMAT =
    /^t?BbC[0-9a-fA-F]{40}$/;

const DEFAULT_SERVER_URL =
    process.env.PAYOUT_SERVER_URL ||
    `http://localhost:${CONFIG.API_PORT}`;

const DEFAULT_MIN_PAYOUT =
    process.env.MIN_PAYOUT ||
    "0";

const CHECK_INTERVAL_MS =
    Number(
        process.env.WATCHER_INTERVAL_MS
    ) || 5000;


let running = false;


function parseMinPayout(value) {
    const parsed =
        Number(value);

    if (
        !Number.isFinite(parsed) ||
        parsed < 0
    ) {
        return 0;
    }

    return parsed;
}


function validMinerAddress(address) {
    return (
        typeof address === "string" &&
        ADDRESS_FORMAT.test(address) &&
        address !== CONFIG.POOL_ADDRESS
    );
}


function getWakeState(
    storage,
    minPayout =
        DEFAULT_MIN_PAYOUT,
    minConfirmations =
        CONFIG.PAYOUT_MIN_CONFIRMATIONS
) {
    if (!storage || !storage.db) {
        throw new Error(
            "getWakeState wymaga Storage"
        );
    }

    const threshold =
        parseMinPayout(
            minPayout
        );

    const ledger =
        new PayoutLedger(
            storage,
            {
                minConfirmations
            }
        );

    /*
     * Watcher aktywnie sprawdza confirmed payouts nawet wtedy,
     * gdy nie ma nowych credits, referral ani active batch.
     *
     * Przy naruszeniu finality zapisuje trwaly halt,
     * ale NIE uruchamia payout.js i NIE dotyka paid credits.
     */
    const integrityAudit =
        ledger.auditConfirmedIntegrity();

    const integrity =
        integrityAudit.integrity;

    if (integrity.halted) {

        return {
            shouldRun: false,
            integrityHalted: true,
            integrity,
            integrityAudit,
            activeBatches: 0,
            pendingReferrals: 0,
            bootstrapUnpaid: 0,
            currentReady: 0,
            legacyDebtAddresses: 0,
            legacyReady: 0,
            newLegacyBlocks: 0
        };
    }

    const active =
        ledger.getActiveBatches();

    const referrals =
        ledger.getReferralPending();

    const state =
        ledger.getState();

    let bootstrapUnpaid = 0;
    let currentReady = 0;
    let legacyDebtAddresses = 0;
    let legacyReady = 0;
    let newLegacyBlocks = 0;

    if (!state) {
        /*
         * Pierwsze uruchomienie po upgrade.
         * payout.js musi wystartowac, aby wykonac migracje
         * legacy-debt-state.json -> payout_state.
         *
         * Nie budzimy sie dla smieciowych adresow.
         */
        bootstrapUnpaid =
            storage
                .getUnpaidCreditsSummary()
                .filter(
                    (row) =>
                        validMinerAddress(
                            row.minerAddress
                        ) &&
                        Number(
                            row.total
                        ) > 0
                )
                .length;
    } else {
        /*
         * Po migracji uzywamy tylko NIEZAREZERWOWANYCH credits.
         * Aktywne batche maja osobna sciezke recovery powyzej.
         */
        const available =
            ledger
                .getAvailableSummary(
                    state.cutoffTimestamp
                );

        for (
            const row of available
        ) {
            if (
                !validMinerAddress(
                    row.minerAddress
                )
            ) {
                continue;
            }

            const currentTotal =
                Number(
                    row.currentTotal || 0
                );

            const legacyTotal =
                Number(
                    row.legacyTotal || 0
                );

            if (
                currentTotal > 0 &&
                currentTotal >=
                    threshold
            ) {
                currentReady++;
            }

            if (legacyTotal > 0) {
                legacyDebtAddresses++;
            }
        }

        if (
            legacyDebtAddresses > 0
        ) {
            /*
             * Nawet jezeli budzet jest jeszcze < 0.01,
             * nowy blok musi obudzic payout.js, bo dopiero
             * engine nalicza 10% reward do accruedBudget.
             */
            newLegacyBlocks =
                storage
                    .getBlockHeightsSince(
                        state.lastCheckedHeight
                    )
                    .length;

            if (
                Number(
                    state.accruedBudget
                ) >=
                    MIN_LEGACY_PAYOUT ||
                newLegacyBlocks > 0
            ) {
                legacyReady =
                    legacyDebtAddresses;
            }
        }
    }

    const result = {
        integrityHalted: false,
        integrity,
        integrityAudit,
        shouldRun:
            active.length > 0 ||
            referrals.length > 0 ||
            bootstrapUnpaid > 0 ||
            currentReady > 0 ||
            legacyReady > 0,

        activeBatches:
            active.length,

        pendingReferrals:
            referrals.length,

        bootstrapUnpaid,

        currentReady,

        legacyDebtAddresses,

        legacyReady,

        newLegacyBlocks
    };

    return result;
}


function checkAndPayout({
    poolKeyPath,
    serverUrl =
        DEFAULT_SERVER_URL,
    minPayout =
        DEFAULT_MIN_PAYOUT,
    execFileImpl =
        execFile
} = {}) {
    if (running) {
        return false;
    }

    if (
        typeof poolKeyPath !==
            "string" ||
        poolKeyPath.length === 0
    ) {
        throw new Error(
            "Brak sciezki do klucza puli"
        );
    }

    let storage = null;

    try {
        storage =
            new Storage(
                CONFIG.DATABASE
            );

        const wake =
            getWakeState(
                storage,
                minPayout
            );

        storage.close();
        storage = null;

        if (wake.integrityHalted) {

            console.error(
                "[" +
                new Date().toISOString() +
                "] CRITICAL PAYOUT INTEGRITY HALT: " +
                JSON.stringify(
                    wake.integrity
                )
            );

            return false;
        }

        if (!wake.shouldRun) {
            return false;
        }

        console.log(
            "[" +
            new Date().toISOString() +
            "] payout wake: " +
            JSON.stringify(
                wake
            )
        );

        running = true;

        execFileImpl(
            "node",
            [
                path.join(
                    __dirname,
                    "payout.js"
                ),
                poolKeyPath,
                serverUrl,
                String(minPayout)
            ],
            {
                cwd:
                    __dirname
            },
            (
                err,
                stdout,
                stderr
            ) => {
                running = false;

                if (
                    stdout &&
                    stdout.trim()
                ) {
                    console.log(
                        stdout.trim()
                    );
                }

                if (
                    stderr &&
                    stderr.trim()
                ) {
                    console.error(
                        "[" +
                        new Date()
                            .toISOString() +
                        "] STDERR payout.js:",
                        stderr.trim()
                    );
                }

                if (err) {
                    console.error(
                        "[" +
                        new Date()
                            .toISOString() +
                        "] payout error:",
                        err.message
                    );
                }
            }
        );

        return true;
    } catch (err) {
        running = false;

        if (storage) {
            try {
                storage.close();
            } catch {}
        }

        console.error(
            "Payout watcher error:",
            err.message
        );

        return false;
    }
}


function startWatcher(
    poolKeyPath
) {
    if (
        typeof poolKeyPath !==
            "string" ||
        poolKeyPath.length === 0
    ) {
        throw new Error(
            "Uzycie: node payout-watcher.js <sciezka_do_klucza.pem>"
        );
    }

    console.log(
        "Payout watcher uruchomiony - interval " +
        CHECK_INTERVAL_MS +
        " ms, min payout " +
        DEFAULT_MIN_PAYOUT
    );

    checkAndPayout({
        poolKeyPath
    });

    return setInterval(
        () =>
            checkAndPayout({
                poolKeyPath
            }),
        CHECK_INTERVAL_MS
    );
}


if (require.main === module) {
    const poolKeyPath =
        process.argv[2];

    if (!poolKeyPath) {
        console.error(
            "Uzycie: node payout-watcher.js <sciezka_do_klucza.pem>"
        );

        process.exit(1);
    }

    startWatcher(
        poolKeyPath
    );
}


module.exports = {
    getWakeState,
    checkAndPayout,
    startWatcher,
    parseMinPayout
};
