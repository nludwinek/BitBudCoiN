"use strict";

const assert =
    require("node:assert/strict");

const fs =
    require("node:fs");

const os =
    require("node:os");

const path =
    require("node:path");

const CONFIG =
    require("./config");

const Storage =
    require("./storage");


let passed = 0;

let chain = null;

let restarted = null;


function pass(name) {

    passed++;

    console.log(
        "PASS " + name
    );
}


function closeBlockchain(instance) {

    if (
        !instance ||
        !instance.storage ||
        !instance.storage.db
    ) {
        return;
    }

    try {
        instance.storage.db.close();
    } catch {}
}


function coinbase(
    height,
    timestamp,
    address
) {

    return {
        from: null,

        to:
            address,

        amount:
            CONFIG.BLOCK_REWARD /
            Math.pow(
                2,
                Math.floor(
                    height /
                    CONFIG.HALVING_INTERVAL
                )
            ),

        fee: 0,

        type:
            "coinbase",

        timestamp
    };
}


const tempDir =
    fs.mkdtempSync(
        path.join(
            os.tmpdir(),
            "bbc-real-replacechain-"
        )
    );


const dbPath =
    path.join(
        tempDir,
        "blockchain.sqlite"
    );


const originalDatabase =
    CONFIG.DATABASE;


const originalDifficulty =
    CONFIG.DIFFICULTY;


try {

    /*
     * ========================================================
     * FORCE PRODUCTION BLOCKCHAIN TO USE TEMP SQLITE
     * ========================================================
     */

    CONFIG.DATABASE =
        dbPath;

    CONFIG.DIFFICULTY =
        1;


    assert.equal(
        CONFIG.DATABASE,
        dbPath
    );


    /*
     * Require Blockchain DOPIERO po zmianie CONFIG.
     * Nie podstawiamy FakeStorage.
     */
    const Blockchain =
        require("./bbcblockchain");


    const {
        computeBlockHash,
        difficultyToTargetHex
    } =
        Blockchain;


    function makeBlock({
        height,
        timestamp,
        previousHash,
        transactions,
        difficulty
    }) {

        const block = {
            height,
            timestamp,
            previousHash,
            transactions,
            difficulty,
            nonce: 0
        };


        const target =
            difficultyToTargetHex(
                difficulty
            );


        block.hash =
            computeBlockHash(
                block
            );


        while (
            block.hash >
            target
        ) {

            block.nonce++;

            block.hash =
                computeBlockHash(
                    block
                );
        }


        return block;
    }


    function extendChain(
        base,
        count,
        minerAddress
    ) {

        const result =
            base.slice();


        let previous =
            result[
                result.length - 1
            ];


        for (
            let i = 0;
            i < count;
            i++
        ) {

            const height =
                previous.height + 1;


            /*
             * +1 sekunda:
             * - monotoniczne,
             * - pozostaje w limicie future drift nawet jesli
             *   genesis testowy powstal "teraz".
             */
            const timestamp =
                previous.timestamp +
                1000;


            const next =
                makeBlock({
                    height,

                    timestamp,

                    previousHash:
                        previous.hash,

                    transactions: [
                        coinbase(
                            height,
                            timestamp,
                            minerAddress
                        )
                    ],

                    difficulty:
                        CONFIG.DIFFICULTY
                });


            result.push(
                next
            );


            previous =
                next;
        }


        return result;
    }


    /*
     * ========================================================
     * REAL PRODUCTION STORAGE
     * ========================================================
     */

    chain =
        new Blockchain();


    assert.ok(
        chain.storage instanceof
        Storage
    );


    assert.equal(
        chain.storage.constructor,
        Storage
    );


    assert.ok(
        fs.existsSync(
            dbPath
        )
    );


    assert.equal(
        chain.chain.length,
        1
    );


    pass(
        "REAL_BLOCKCHAIN_USES_REAL_TEMP_SQLITE"
    );


    /*
     * ========================================================
     * FIRST LONGER CHAIN
     * ========================================================
     */

    const minerA =
        "BbC" +
        "a".repeat(40);


    const firstCandidate =
        extendChain(
            chain.chain,
            2,
            minerA
        );


    const firstResult =
        chain.replaceChain(
            firstCandidate
        );


    assert.equal(
        firstResult.accepted,
        true,
        firstResult.reason ||
            "first replaceChain rejected"
    );


    assert.equal(
        chain.chain.length,
        3
    );


    assert.equal(
        chain.chain[2].hash,
        firstCandidate[2].hash
    );


    const firstDisk =
        chain.storage
            .loadChain();


    assert.equal(
        firstDisk.length,
        3
    );


    assert.equal(
        firstDisk[2].hash,
        firstCandidate[2].hash
    );


    assert.equal(
        chain.storage.db
            .prepare(`
                SELECT COUNT(*) AS n
                FROM blocks
            `)
            .get()
            .n,
        3
    );


    pass(
        "FIRST_LONGER_CHAIN_ACCEPTED_AND_PERSISTED"
    );


    /*
     * ========================================================
     * INDEXES AFTER replaceChain()
     * ========================================================
     */

    assert.ok(
        chain.blockByHeight
    );


    assert.equal(
        chain.blockByHeight
            .get(2)
            .hash,
        firstCandidate[2].hash
    );


    assert.ok(
        chain.getBalance(
            minerA
        ) > 0
    );


    pass(
        "INDEXES_REBUILT_AFTER_REPLACE"
    );


    /*
     * ========================================================
     * SECOND, DIFFERENT, LONGER BRANCH = REAL REORG
     * ========================================================
     */

    const minerB =
        "BbC" +
        "b".repeat(40);


    /*
     * Startujemy ponownie od genesis.
     *
     * Pierwsza gałąź:
     *   0 -> A1 -> A2
     *
     * Druga:
     *   0 -> B1 -> B2 -> B3
     *
     * Druga jest dłuższa i ma inne coinbase/hash.
     */
    const genesisOnly = [
        chain.chain[0]
    ];


    const secondCandidate =
        extendChain(
            genesisOnly,
            3,
            minerB
        );


    assert.notEqual(
        secondCandidate[1].hash,
        firstCandidate[1].hash
    );


    const oldTipHash =
        chain.chain[2].hash;


    const secondResult =
        chain.replaceChain(
            secondCandidate
        );


    assert.equal(
        secondResult.accepted,
        true,
        secondResult.reason ||
            "second replaceChain rejected"
    );


    assert.equal(
        chain.chain.length,
        4
    );


    assert.equal(
        chain.chain[3].hash,
        secondCandidate[3].hash
    );


    assert.notEqual(
        chain.chain[2].hash,
        oldTipHash
    );


    pass(
        "SECOND_REAL_REORG_ACCEPTED"
    );


    /*
     * ========================================================
     * OLD BRANCH MUST REALLY DISAPPEAR FROM SQLITE
     * ========================================================
     */

    const oldMinerTransactions =
        chain.storage.db
            .prepare(`
                SELECT COUNT(*) AS n
                FROM transactions
                WHERE to_address = ?
            `)
            .get(
                minerA
            )
            .n;


    const newMinerTransactions =
        chain.storage.db
            .prepare(`
                SELECT COUNT(*) AS n
                FROM transactions
                WHERE to_address = ?
            `)
            .get(
                minerB
            )
            .n;


    assert.equal(
        oldMinerTransactions,
        0
    );


    assert.equal(
        newMinerTransactions,
        3
    );


    const oldTipOnDisk =
        chain.storage.db
            .prepare(`
                SELECT COUNT(*) AS n
                FROM blocks
                WHERE hash = ?
            `)
            .get(
                oldTipHash
            )
            .n;


    assert.equal(
        oldTipOnDisk,
        0
    );


    assert.equal(
        chain.storage.db
            .prepare(`
                SELECT COUNT(*) AS n
                FROM blocks
            `)
            .get()
            .n,
        4
    );


    pass(
        "OLD_BRANCH_REMOVED_FROM_SQLITE"
    );


    /*
     * ========================================================
     * RESTART NODE FROM THE SAME SQLITE
     * ========================================================
     */

    closeBlockchain(
        chain
    );

    chain = null;


    restarted =
        new Blockchain();


    assert.ok(
        restarted.storage instanceof
        Storage
    );


    assert.equal(
        restarted.chain.length,
        4
    );


    assert.equal(
        restarted.chain[3].hash,
        secondCandidate[3].hash
    );


    assert.equal(
        restarted.blockByHeight
            .get(3)
            .hash,
        secondCandidate[3].hash
    );


    assert.equal(
        restarted.getBalance(
            minerA
        ),
        0
    );


    assert.ok(
        restarted.getBalance(
            minerB
        ) > 0
    );


    pass(
        "RESTART_LOADS_REORGED_CANONICAL_CHAIN"
    );


    /*
     * ========================================================
     * DATABASE INTEGRITY
     * ========================================================
     */

    const fkErrors =
        restarted.storage.db
            .prepare(
                "PRAGMA foreign_key_check"
            )
            .all();


    assert.equal(
        fkErrors.length,
        0
    );


    pass(
        "POST_REORG_FOREIGN_KEYS_VALID"
    );


    console.log("");

    console.log(
        `RESULT REAL SQLITE REPLACECHAIN: ${passed}/7 PASS`
    );


    if (passed !== 7) {
        process.exitCode = 1;
    }

}
finally {

    closeBlockchain(
        chain
    );


    closeBlockchain(
        restarted
    );


    CONFIG.DATABASE =
        originalDatabase;


    CONFIG.DIFFICULTY =
        originalDifficulty;


    try {
        fs.rmSync(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );
    } catch {}
}