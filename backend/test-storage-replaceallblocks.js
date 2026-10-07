"use strict";

const assert =
    require("node:assert/strict");

const fs =
    require("node:fs");

const os =
    require("node:os");

const path =
    require("node:path");

const Storage =
    require("./storage");


let passed = 0;


function pass(name) {

    passed++;

    console.log(
        "PASS " + name
    );
}


function tx({
    from,
    to,
    amount,
    timestamp,
    signature
}) {

    return {
        from,
        to,
        amount,
        type: "transfer",
        fee: 0.01,
        timestamp,
        publicKey:
            "TEST_PUBLIC_KEY",
        signature
    };
}


function block({
    height,
    previousHash,
    hash,
    timestamp,
    transactions = []
}) {

    return {
        height,
        timestamp,
        previousHash,
        hash,
        nonce: height + 10,
        difficulty: 1,
        transactions
    };
}


const tempDir =
    fs.mkdtempSync(
        path.join(
            os.tmpdir(),
            "bbc-replaceallblocks-"
        )
    );

const dbPath =
    path.join(
        tempDir,
        "chain.sqlite"
    );

let storage = null;


try {

    storage =
        new Storage(
            dbPath
        );


    /*
     * ========================================================
     * INITIAL CHAIN
     * ========================================================
     */

    const oldChain = [
        block({
            height: 0,
            previousHash:
                "0".repeat(64),
            hash:
                "a".repeat(64),
            timestamp:
                1000
        }),

        block({
            height: 1,
            previousHash:
                "a".repeat(64),
            hash:
                "b".repeat(64),
            timestamp:
                2000,
            transactions: [
                tx({
                    from:
                        "BbC" +
                        "1".repeat(40),
                    to:
                        "BbC" +
                        "2".repeat(40),
                    amount:
                        1.25,
                    timestamp:
                        1900,
                    signature:
                        "OLD_SIGNATURE"
                })
            ]
        })
    ];


    for (
        const b of
        oldChain
    ) {
        storage.saveBlock(
            b
        );
    }


    storage.saveMempoolTx({
        from:
            "BbC" +
            "3".repeat(40),

        to:
            "BbC" +
            "4".repeat(40),

        amount:
            2,

        fee:
            0.01,

        timestamp:
            2500,

        publicKey:
            "TEST_MEMPOOL_PUBLIC_KEY",

        signature:
            "PENDING_SIGNATURE",

        receivedAt:
            2600
    });


    storage.saveCredit({
        minerAddress:
            "BbC" +
            "5".repeat(40),

        blockHeight:
            1,

        shares:
            10,

        amount:
            0.5,

        timestamp:
            2700
    });


    assert.equal(
        storage.db.prepare(
            "SELECT COUNT(*) AS n FROM blocks"
        ).get().n,
        2
    );

    assert.equal(
        storage.db.prepare(
            "SELECT COUNT(*) AS n FROM transactions"
        ).get().n,
        1
    );

    pass(
        "INITIAL_REAL_SQLITE_STATE"
    );


    /*
     * ========================================================
     * VALID REPLACEMENT
     * ========================================================
     */

    const newChain = [
        block({
            height: 0,
            previousHash:
                "0".repeat(64),
            hash:
                "a".repeat(64),
            timestamp:
                1000
        }),

        block({
            height: 1,
            previousHash:
                "a".repeat(64),
            hash:
                "c".repeat(64),
            timestamp:
                2100
        }),

        block({
            height: 2,
            previousHash:
                "c".repeat(64),
            hash:
                "d".repeat(64),
            timestamp:
                3100,
            transactions: [
                tx({
                    from:
                        "BbC" +
                        "6".repeat(40),
                    to:
                        "BbC" +
                        "7".repeat(40),
                    amount:
                        3.5,
                    timestamp:
                        3000,
                    signature:
                        "NEW_SIGNATURE"
                })
            ]
        })
    ];


    storage.replaceAllBlocks(
        newChain
    );


    const loaded =
        storage.loadChain();


    assert.equal(
        loaded.length,
        3
    );

    assert.equal(
        loaded[0].hash,
        "a".repeat(64)
    );

    assert.equal(
        loaded[1].hash,
        "c".repeat(64)
    );

    assert.equal(
        loaded[2].hash,
        "d".repeat(64)
    );

    assert.equal(
        loaded[2]
            .transactions
            .length,
        1
    );

    assert.equal(
        loaded[2]
            .transactions[0]
            .signature,
        "NEW_SIGNATURE"
    );

    pass(
        "CHAIN_REPLACED_ON_REAL_SQLITE"
    );


    /*
     * ========================================================
     * OLD TX MUST DISAPPEAR / NEW TX MUST HAVE NEW HEIGHT
     * ========================================================
     */

    const oldTx =
        storage.db.prepare(`
            SELECT
                blockHeight,
                signature
            FROM transactions
            WHERE signature = ?
        `).get(
            "OLD_SIGNATURE"
        );


    const newTx =
        storage.db.prepare(`
            SELECT
                blockHeight,
                signature
            FROM transactions
            WHERE signature = ?
        `).get(
            "NEW_SIGNATURE"
        );


    assert.equal(
        oldTx,
        undefined
    );

    assert.ok(
        newTx
    );

    assert.equal(
        newTx.blockHeight,
        2
    );

    pass(
        "TRANSACTION_SET_REPLACED"
    );


    /*
     * ========================================================
     * UNRELATED TABLES MUST SURVIVE
     * ========================================================
     */

    assert.equal(
        storage.db.prepare(
            "SELECT COUNT(*) AS n FROM mempool WHERE signature = ?"
        ).get(
            "PENDING_SIGNATURE"
        ).n,
        1
    );


    assert.equal(
        storage.db.prepare(
            "SELECT COUNT(*) AS n FROM pool_credits"
        ).get().n,
        1
    );

    pass(
        "UNRELATED_TABLES_PRESERVED"
    );


    /*
     * ========================================================
     * FK INTEGRITY
     * ========================================================
     */

    const fkErrors =
        storage.db.prepare(
            "PRAGMA foreign_key_check"
        ).all();


    assert.equal(
        fkErrors.length,
        0
    );

    pass(
        "FOREIGN_KEYS_VALID"
    );


    /*
     * ========================================================
     * FAILED REPLACEMENT MUST ROLLBACK EVERYTHING
     * ========================================================
     */

    const beforeFailure =
        JSON.stringify(
            storage.loadChain()
        );


    const brokenChain = [
        block({
            height: 0,
            previousHash:
                "0".repeat(64),
            hash:
                "e".repeat(64),
            timestamp:
                4000
        }),

        block({
            height: 1,
            previousHash:
                "e".repeat(64),
            hash:
                "f".repeat(64),
            timestamp:
                5000,
            transactions: [
                {
                    from:
                        "BbC" +
                        "8".repeat(40),

                    /*
                     * to_address jest NOT NULL.
                     * Ten rekord CELOWO musi wywolac SQLite error
                     * juz po rozpoczeciu replacement transaction.
                     */
                    to:
                        null,

                    amount:
                        9,

                    type:
                        "transfer",

                    fee:
                        0.01,

                    timestamp:
                        4900,

                    publicKey:
                        "TEST",

                    signature:
                        "BROKEN_SIGNATURE"
                }
            ]
        })
    ];


    assert.throws(
        () =>
            storage
                .replaceAllBlocks(
                    brokenChain
                )
    );


    const afterFailure =
        JSON.stringify(
            storage.loadChain()
        );


    assert.equal(
        afterFailure,
        beforeFailure
    );


    assert.equal(
        storage.db.prepare(
            "SELECT COUNT(*) AS n FROM transactions WHERE signature = ?"
        ).get(
            "NEW_SIGNATURE"
        ).n,
        1
    );


    assert.equal(
        storage.db.prepare(
            "SELECT COUNT(*) AS n FROM transactions WHERE signature = ?"
        ).get(
            "BROKEN_SIGNATURE"
        ).n,
        0
    );


    pass(
        "FAILED_REPLACEMENT_ROLLS_BACK"
    );


    /*
     * ========================================================
     * EMPTY CHAIN MUST FAIL WITHOUT TOUCHING DATABASE
     * ========================================================
     */

    const beforeEmpty =
        JSON.stringify(
            storage.loadChain()
        );


    assert.throws(
        () =>
            storage
                .replaceAllBlocks(
                    []
                ),
        /Nieprawidlowy lancuch/
    );


    assert.equal(
        JSON.stringify(
            storage.loadChain()
        ),
        beforeEmpty
    );


    pass(
        "EMPTY_CHAIN_FAILS_CLOSED"
    );


    console.log("");

    console.log(
        `RESULT STORAGE REPLACE ALL BLOCKS: ${passed}/7 PASS`
    );


    if (passed !== 7) {
        process.exitCode = 1;
    }

}
finally {

    if (storage) {

        try {
            storage.close();
        } catch {

            try {
                storage.db.close();
            } catch {}
        }
    }


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
