"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    fork
} = require("child_process");

const Storage = require("./storage");
const PayoutLedger = require("./payout-ledger");


const MINER =
    "BbC" + "a".repeat(40);

const POOL =
    "BbC" + "f".repeat(40);

const WORKER =
    path.join(
        __dirname,
        "test-payout-concurrency-worker.js"
    );


function pass(name) {
    console.log(
        "PASS " + name
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


function spawnWorker(
    dbPath,
    batchId
) {
    const child =
        fork(
            WORKER,
            [
                dbPath,
                batchId
            ],
            {
                stdio: [
                    "ignore",
                    "ignore",
                    "ignore",
                    "ipc"
                ]
            }
        );

    let readyResolve;
    let readyReject;

    let resultResolve;
    let resultReject;

    let exitResolve;
    let exitReject;

    let gotResult = false;

    const exited =
        new Promise(
            (
                resolve,
                reject
            ) => {
                exitResolve =
                    resolve;
                exitReject =
                    reject;
            }
        );

    const ready =
        new Promise(
            (
                resolve,
                reject
            ) => {
                readyResolve =
                    resolve;
                readyReject =
                    reject;
            }
        );

    const result =
        new Promise(
            (
                resolve,
                reject
            ) => {
                resultResolve =
                    resolve;
                resultReject =
                    reject;
            }
        );

    const timer =
        setTimeout(
            () => {
                try {
                    child.kill();
                } catch {}

                const err =
                    new Error(
                        "worker timeout"
                    );

                readyReject(
                    err
                );

                resultReject(
                    err
                );
            },
            15000
        );

    child.on(
        "message",
        (message) => {
            if (
                message &&
                message.type ===
                    "ready"
            ) {
                readyResolve();
            }

            if (
                message &&
                message.type ===
                    "result"
            ) {
                gotResult = true;

                clearTimeout(
                    timer
                );

                resultResolve(
                    message
                );
            }
        }
    );

    child.on(
        "error",
        (err) => {
            clearTimeout(
                timer
            );

            readyReject(
                err
            );

            resultReject(
                err
            );

            exitReject(
                err
            );
        }
    );

    child.on(
        "exit",
        (code) => {
            if (code === 0) {
                exitResolve(
                    code
                );

                return;
            }

            const err =
                new Error(
                    "worker exited with code " +
                    code
                );

            exitReject(
                err
            );

            if (!gotResult) {
                readyReject(
                    err
                );

                resultReject(
                    err
                );
            }
        }
    );

    return {
        child,
        ready,
        result,
        exited
    };
}


async function oneRound(
    round
) {
    const dbPath =
        path.join(
            os.tmpdir(),
            "bbc-payout-race-" +
                process.pid +
                "-" +
                Date.now() +
                "-" +
                round +
                ".db"
        );

    let storage = null;

    try {
        /*
         * Tworzymy tylko bazowy schemat Storage.
         * NIE konstruujemy PayoutLedger w rodzicu,
         * wiec payoutBatchId jeszcze nie istnieje.
         */
        storage =
            new Storage(
                dbPath
            );

        storage.saveCredit({
            minerAddress:
                MINER,
            blockHeight: 0,
            shares: 1,
            amount: 5,
            timestamp: 2000
        });

        storage.close();
        storage = null;


        const w1 =
            spawnWorker(
                dbPath,
                "race-a-" +
                    round
            );

        const w2 =
            spawnWorker(
                dbPath,
                "race-b-" +
                    round
            );

        /*
         * Bariera:
         * oba procesy maja otwarte SQLite zanim
         * pozwalamy im skonstruowac PayoutLedger.
         */
        await Promise.all([
            w1.ready,
            w2.ready
        ]);

        const go = {
            cmd: "go",
            minerAddress:
                MINER,
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
        };

        w1.child.send(go);
        w2.child.send(go);

        const results =
            await Promise.all([
                w1.result,
                w2.result
            ]);

        /*
         * Wynik IPC oznacza, ze worker skonczyl operacje logiczna.
         * Nie oznacza jeszcze, ze OS/SQLite zwolnil uchwyt do bazy.
         *
         * Czekamy na prawdziwe zakonczenie obu procesow zanim rodzic
         * ponownie otworzy SQLite do inspekcji wyniku.
         */
        await Promise.all([
            w1.exited,
            w2.exited
        ]);

        for (
            const result of results
        ) {
            assert.equal(
                result.ok,
                true,
                result.error ||
                    "worker failed"
            );
        }

        const winners =
            results.filter(
                (result) =>
                    result.reserved
            );

        assert.equal(
            winners.length,
            1,
            "exactly one process must reserve credits"
        );


        storage =
            new Storage(
                dbPath
            );

        const ledger =
            new PayoutLedger(
                storage
            );

        const columns =
            storage.db
                .prepare(
                    "PRAGMA table_info(pool_credits)"
                )
                .all()
                .filter(
                    (column) =>
                        column.name ===
                        "payoutBatchId"
                );

        assert.equal(
            columns.length,
            1
        );

        const active =
            ledger
                .getActiveBatches();

        assert.equal(
            active.length,
            1
        );

        assert.equal(
            active[0].batchId,
            winners[0].batchId
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
            winners[0].batchId
        );

        storage.close();
        storage = null;

        return {
            winner:
                winners[0]
                    .batchId
        };
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


(async () => {
    /*
     * Kilka niezaleznych pierwszych startow.
     * Kazdy zaczyna od DB bez payoutBatchId.
     */
    const rounds = 8;

    for (
        let i = 1;
        i <= rounds;
        i++
    ) {
        await oneRound(i);
    }

    pass(
        "MULTIPROCESS_SCHEMA_INIT_SURVIVES"
    );

    pass(
        "EXACTLY_ONE_PROCESS_RESERVES_CREDITS"
    );

    pass(
        "WINNER_OWNS_EXACT_CREDIT_AUDIT_LINK"
    );

    console.log("");
    console.log(
        "RESULT PAYOUT CONCURRENCY: 3/3 PASS"
    );
})().catch(
    (err) => {
        console.error(err);
        process.exitCode = 1;
    }
);
