"use strict";

const Storage = require("./storage");
const PayoutLedger = require("./payout-ledger");


const dbPath =
    process.argv[2];

const batchId =
    process.argv[3];


if (!dbPath || !batchId) {
    process.exit(2);
}


let storage;

try {
    /*
     * Otwieramy Storage PRZED bariera rodzica.
     * Oba procesy maja juz polaczenie do tej samej bazy,
     * ale payout-ledger nie zostal jeszcze skonstruowany.
     */
    storage =
        new Storage(
            dbPath
        );

    if (process.send) {
        process.send({
            type: "ready"
        });
    }
} catch (err) {
    if (process.send) {
        process.send({
            type: "result",
            ok: false,
            error:
                err.stack ||
                err.message ||
                String(err)
        });
    }

    process.exit(1);
}


process.on(
    "message",
    (message) => {
        if (
            !message ||
            message.cmd !== "go"
        ) {
            return;
        }

        try {
            /*
             * Oba procesy wchodza tutaj praktycznie jednoczesnie.
             *
             * Testuje to jednoczesnie:
             * 1. race ADD COLUMN payoutBatchId
             * 2. BEGIN IMMEDIATE
             * 3. przejecie dokladnie tych samych credits
             */
            const ledger =
                new PayoutLedger(
                    storage
                );

            const batch =
                ledger.reserveCurrent({
                    batchId,
                    minerAddress:
                        message.minerAddress,
                    fromAddress:
                        message.fromAddress,
                    cutoffMs:
                        message.cutoffMs,
                    minPayout:
                        message.minPayout,
                    fee:
                        message.fee,
                    txTimestamp:
                        message.txTimestamp
                });

            if (process.send) {
                process.send({
                    type: "result",
                    ok: true,
                    reserved:
                        Boolean(batch),
                    batchId:
                        batch
                            ? batch.batchId
                            : null,
                    amount:
                        batch
                            ? batch.amount
                            : null
                });
            }

            storage.close();
            storage = null;

            setTimeout(
                () =>
                    process.exit(0),
                10
            );
        } catch (err) {
            if (process.send) {
                process.send({
                    type: "result",
                    ok: false,
                    error:
                        err.stack ||
                        err.message ||
                        String(err)
                });
            }

            try {
                if (storage) {
                    storage.close();
                }
            } catch {}

            setTimeout(
                () =>
                    process.exit(1),
                10
            );
        }
    }
);
