"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { once } = require("events");

const moduleArg =
    process.argv[2] ||
    "./server.js";

/*
 * BARDZO WAŻNE:
 * DATABASE_PATH ustawiamy PRZED require(server.js),
 * ponieważ Blockchain powstaje podczas importu.
 */
const dbPath = path.join(
    __dirname,
    `.stage1-http-${process.pid}-${Date.now()}.db`
);

process.env.DATABASE_PATH = dbPath;
process.env.PORT = "0";

const serverModulePath =
    path.resolve(__dirname, moduleArg);

const {
    app,
    server,
    blockchain,
    pool,
    p2p
} = require(serverModulePath);

const {
    computeBlockHash
} = require("./bbcblockchain");

const MINER =
    "BbC" + "2".repeat(40);

let httpServer = null;
let passed = 0;
let failed = 0;

function pass(name) {
    passed++;
    console.log(`PASS ${name}`);
}

function fail(name, err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(`     ${err.message}`);
}

async function test(name, fn) {
    try {
        await fn();
        pass(name);
    } catch (err) {
        fail(name, err);
    }
}

function sleep(ms) {
    return new Promise(
        (resolve) => setTimeout(resolve, ms)
    );
}

function makeCandidate(work, nonce) {
    const candidate = {
        height: work.height,
        previousHash: work.previousHash,
        timestamp: work.timestamp,
        transactions:
            JSON.parse(
                JSON.stringify(work.transactions)
            ),
        difficulty: work.difficulty,
        nonce
    };

    candidate.hash =
        computeBlockHash(candidate);

    return candidate;
}

function mineOrdinaryShare(
    work,
    maxAttempts = 1_000_000
) {
    for (
        let nonce = 0;
        nonce < maxAttempts;
        nonce++
    ) {
        const candidate =
            makeCandidate(work, nonce);

        /*
         * Chcemy SHARE, ale NIE pełny blok.
         * Dzięki temu endpoint nie próbuje robić
         * broadcastNewBlock() przez nieuruchomiony P2P.
         */
        if (
            candidate.hash <= work.shareTarget &&
            candidate.hash > work.blockTarget
        ) {
            return candidate;
        }
    }

    throw new Error(
        `Nie znaleziono ordinary share po ${maxAttempts} probach`
    );
}

async function jsonRequest(
    url,
    options = {}
) {
    const response =
        await fetch(url, options);

    const text =
        await response.text();

    let data = null;

    try {
        data =
            text
                ? JSON.parse(text)
                : null;
    } catch (_) {
        data = {
            raw: text
        };
    }

    return {
        status: response.status,
        data
    };
}

async function cleanup() {
    if (httpServer) {
        await new Promise((resolve) => {
            httpServer.close(() => resolve());
        });

        httpServer = null;
    }

    try {
        p2p.close();
    } catch (_) {}

    try {
        blockchain.close();
    } catch (_) {}

    for (const file of [
        dbPath,
        dbPath + "-wal",
        dbPath + "-shm"
    ]) {
        try {
            fs.rmSync(
                file,
                {
                    force: true
                }
            );
        } catch (_) {}
    }
}

async function main() {
    try {

        /*
         * IMPORT-SAFETY.
         *
         * Gdy server.js jest wymagany przez test,
         * NIE może sam uruchomić app.listen().
         */
        await test(
            "IMPORT_NO_AUTOLISTEN",
            async () => {
                assert.strictEqual(
                    server,
                    null
                );
            }
        );

        /*
         * Używamy kontrolowanej trudności:
         *
         * block = 1024
         * share = 16
         *
         * daje zwykle ordinary share w kilkunastu
         * próbach, ale pełny blok jest znacznie rzadszy.
         */
        blockchain.difficulty = 1024;

        pool.minerDifficulty.set(
            MINER,
            16
        );

        pool.minerLastShareAt.set(
            MINER,
            Date.now()
        );

        /*
         * Startujemy WYŁĄCZNIE Express,
         * na losowym wolnym porcie systemowym.
         */
        httpServer =
            app.listen(
                0,
                "127.0.0.1"
            );

        await once(
            httpServer,
            "listening"
        );

        const address =
            httpServer.address();

        assert(address);
        assert.strictEqual(
            typeof address.port,
            "number"
        );

        const base =
            `http://127.0.0.1:${address.port}`;

        let work;

        await test(
            "GET_WORK_HAS_WORKID",
            async () => {
                const r =
                    await jsonRequest(
                        `${base}/pool/work?minerAddress=${encodeURIComponent(MINER)}`
                    );

                assert.strictEqual(
                    r.status,
                    200
                );

                assert(r.data);

                assert.strictEqual(
                    typeof r.data.workId,
                    "string"
                );

                assert(
                    /^[0-9a-f]{32}$/.test(
                        r.data.workId
                    ),
                    `Nieprawidlowy workId: ${r.data.workId}`
                );

                assert(
                    /^[0-9a-f]{64}$/.test(
                        r.data.shareTarget
                    )
                );

                assert(
                    /^[0-9a-f]{64}$/.test(
                        r.data.blockTarget
                    )
                );

                work = r.data;
            }
        );

        if (!work) {
            throw new Error(
                "GET /pool/work nie zwrocil pracy - dalsze testy nie maja sensu"
            );
        }

        const candidate =
            mineOrdinaryShare(work);

        /*
         * Endpoint ma wspólny limiter.
         * Nie chcemy pomylić HTTP 429 z błędem protokołu.
         */
        await sleep(500);

        await test(
            "POST_MISSING_WORKID",
            async () => {
                const r =
                    await jsonRequest(
                        `${base}/pool/submit`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json"
                            },
                            body:
                                JSON.stringify({
                                    minerAddress:
                                        MINER,
                                    candidate
                                })
                        }
                    );

                assert.strictEqual(
                    r.status,
                    400
                );

                assert.strictEqual(
                    r.data.code,
                    "UNKNOWN_JOB"
                );
            }
        );

        await sleep(500);

        await test(
            "POST_UNKNOWN_WORKID",
            async () => {
                const r =
                    await jsonRequest(
                        `${base}/pool/submit`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json"
                            },
                            body:
                                JSON.stringify({
                                    minerAddress:
                                        MINER,
                                    workId:
                                        "f".repeat(32),
                                    candidate
                                })
                        }
                    );

                assert.strictEqual(
                    r.status,
                    400
                );

                assert.strictEqual(
                    r.data.code,
                    "UNKNOWN_JOB"
                );
            }
        );

        await sleep(500);

        await test(
            "POST_VALID_WORKID",
            async () => {
                const r =
                    await jsonRequest(
                        `${base}/pool/submit`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json"
                            },
                            body:
                                JSON.stringify({
                                    minerAddress:
                                        MINER,
                                    workId:
                                        work.workId,
                                    candidate
                                })
                        }
                    );

                assert.strictEqual(
                    r.status,
                    200
                );

                assert.strictEqual(
                    r.data.accepted,
                    true
                );

                assert.strictEqual(
                    r.data.share,
                    true
                );

                assert.strictEqual(
                    r.data.blockFound,
                    false
                );

                assert(
                    Number(r.data.paidNow) > 0,
                    `paidNow=${r.data.paidNow}`
                );
            }
        );

    } finally {
        await cleanup();
    }

    console.log("");
    console.log(
        `RESULT HTTP: ${passed}/${passed + failed} PASS`
    );

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch(async (err) => {
    console.error(
        "FATAL HTTP TEST:",
        err
    );

    try {
        await cleanup();
    } catch (_) {}

    process.exitCode = 1;
});
