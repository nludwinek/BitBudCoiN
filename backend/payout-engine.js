"use strict";

const crypto = require("crypto");

const {
    signTransaction
} = require("./wallet");

const PayoutLedger =
    require("./payout-ledger");

const {
    ReferralReward
} = require("./referral-reward");

const ADDRESS_FORMAT =
    /^t?BbC[0-9a-fA-F]{40}$/;

function normalizeReason(value) {
    return String(value || "")
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .toLowerCase();
}

function reasonFromData(data) {
    if (!data) {
        return "";
    }

    if (typeof data === "string") {
        return data;
    }

    return (
        data.reason ??
        data.error ??
        data.message ??
        ""
    );
}

function classifySubmission(
    status,
    data
) {
    const reason =
        reasonFromData(data);

    const normalized =
        normalizeReason(reason);

    if (
        status >= 200 &&
        status < 300 &&
        data &&
        data.accepted === true
    ) {
        return {
            kind: "accepted",
            status,
            data,
            reason
        };
    }

    if (
        normalized.includes(
            "mempool"
        ) ||
        normalized.includes(
            "powtorzen"
        ) ||
        normalized.includes(
            "already"
        ) ||
        normalized.includes(
            "duplicate"
        ) ||
        normalized.includes(
            "juz jest w lancuchu"
        )
    ) {
        return {
            kind: "duplicate",
            status,
            data,
            reason
        };
    }

    if (status === 400) {
        return {
            kind: "rejected",
            status,
            data,
            reason
        };
    }

    if (
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500
    ) {
        return {
            kind: "transient",
            status,
            data,
            reason
        };
    }

    if (
        status >= 200 &&
        status < 300 &&
        data &&
        data.accepted === false
    ) {
        return {
            kind: "rejected",
            status,
            data,
            reason
        };
    }

    return {
        kind: "transient",
        status,
        data,
        reason
    };
}

async function submitCandidateHttp(
    serverUrl,
    candidate,
    fetchImpl = globalThis.fetch
) {
    if (
        typeof fetchImpl !==
        "function"
    ) {
        throw new Error(
            "Brak implementacji fetch"
        );
    }

    let response;

    try {
        response =
            await fetchImpl(
                `${serverUrl}/transactions/send`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json"
                    },
                    body:
                        JSON.stringify(
                            candidate
                        )
                }
            );
    } catch (err) {
        return {
            kind: "unknown",
            status: null,
            data: null,
            reason:
                err &&
                err.message
                    ? err.message
                    : String(err)
        };
    }

    const raw =
        await response
            .text()
            .catch(
                () => ""
            );

    let data = null;

    try {
        data =
            raw
                ? JSON.parse(raw)
                : null;
    } catch {
        data = raw;
    }

    return classifySubmission(
        response.status,
        data
    );
}

class PayoutEngine {
    constructor({
        storage,
        privateKey,
        publicKey,
        poolAddress,
        serverUrl,
        fee,
        minPayout = 1,
        maxSinglePayout,
        minConfirmations = 1,
        submitFn,
        now = () => Date.now(),
        sleepFn =
            (ms) =>
                new Promise(
                    (resolve) =>
                        setTimeout(
                            resolve,
                            ms
                        )
                ),
        delayMs = 1200
    }) {
        if (!storage || !storage.db) {
            throw new Error(
                "PayoutEngine wymaga Storage"
            );
        }

        if (
            typeof privateKey !==
                "string" ||
            typeof publicKey !==
                "string"
        ) {
            throw new Error(
                "Brak kluczy puli"
            );
        }

        if (
            !ADDRESS_FORMAT.test(
                poolAddress
            )
        ) {
            throw new Error(
                "Nieprawidlowy poolAddress"
            );
        }

        for (
            const [
                value,
                name
            ] of [
                [fee, "fee"],
                [
                    minPayout,
                    "minPayout"
                ],
                [
                    maxSinglePayout,
                    "maxSinglePayout"
                ]
            ]
        ) {
            if (
                typeof value !==
                    "number" ||
                !Number.isFinite(value) ||
                value < 0
            ) {
                throw new Error(
                    `${name} musi byc skonczona liczba >= 0`
                );
            }
        }

        if (
            !(maxSinglePayout > 0)
        ) {
            throw new Error(
                "maxSinglePayout musi byc > 0"
            );
        }

        this.storage = storage;
        this.privateKey =
            privateKey;
        this.publicKey =
            publicKey;
        this.poolAddress =
            poolAddress;
        this.serverUrl =
            String(
                serverUrl || ""
            ).replace(/\/+$/, "");
        this.fee = fee;
        this.minPayout =
            minPayout;
        this.maxSinglePayout =
            maxSinglePayout;
        this.now = now;
        this.sleepFn =
            sleepFn;
        this.delayMs =
            delayMs;

        this.ledger =
            new PayoutLedger(
                storage,
                {
                    minConfirmations
                }
            );

        this.referral =
            new ReferralReward(
                storage
            );

        this.submitFn =
            submitFn ||
            (
                (candidate) =>
                    submitCandidateHttp(
                        this.serverUrl,
                        candidate
                    )
            );
    }

    newBatchId(kind) {
        return (
            kind +
            "-" +
            crypto
                .randomBytes(16)
                .toString("hex")
        );
    }

    buildCandidate(batch) {
        const tx = {
            from:
                batch.fromAddress,
            to:
                batch.minerAddress,
            amount:
                Number(
                    batch.amount
                ),
            fee:
                Number(
                    batch.fee
                ),
            timestamp:
                Number(
                    batch.txTimestamp
                )
        };

        const signature =
            signTransaction(
                tx,
                this.privateKey
            );

        return {
            ...tx,
            publicKey:
                this.publicKey,
            signature
        };
    }

    ensureCandidate(batch) {
        if (batch.candidate) {
            return batch;
        }

        const candidate =
            this.buildCandidate(
                batch
            );

        return this.ledger
            .attachCandidate(
                batch.batchId,
                candidate
            );
    }

    _evidence(batch) {
        return this.ledger
            .getEvidence(
                batch.txSignature
            );
    }

    _integrityError(
        state
    ) {

        const reason =
            state &&
            state.reason
                ? state.reason
                : "UNKNOWN_INTEGRITY_FAILURE";

        const err =
            new Error(
                "PAYOUT_INTEGRITY_HALT: " +
                reason
            );

        err.code =
            "PAYOUT_INTEGRITY_HALT";

        err.integrityState =
            state || null;

        return err;
    }


    _assertNotHalted() {

        const state =
            this.ledger
                .getIntegrityState();

        if (state.halted) {
            throw this
                ._integrityError(
                    state
                );
        }

        return state;
    }


    _tripIntegrityHalt(
        batch,
        evidence,
        reason
    ) {

        const state =
            this.ledger
                .tripIntegrityHalt({
                    reason,

                    batchId:
                        batch.batchId,

                    txSignature:
                        batch.txSignature ||
                        null,

                    evidence
                });

        throw this
            ._integrityError(
                state
            );
    }


    auditConfirmedIntegrity() {

        const audit =
            this.ledger
                .auditConfirmedIntegrity();

        if (!audit.ok) {

            throw this
                ._integrityError(
                    audit.integrity
                );
        }

        return audit;
    }

    _finalizeIfConfirmed(
        batch
    ) {
        const evidence =
            this._evidence(
                batch
            );

        if (!evidence.confirmed) {
            return null;
        }

        const finalized =
            this.ledger.finalize(
                batch.batchId
            );

        return {
            status:
                "confirmed",
            batch:
                finalized,
            evidence
        };
    }

    async resolveBatch(
        batch
    ) {

        this._assertNotHalted();

        let current =
            this.ledger.getBatch(
                batch.batchId
            );

        if (!current) {
            throw new Error(
                "Batch zniknal z ledger"
            );
        }

        if (
            current.state ===
            "confirmed"
        ) {

            if (!current.txSignature) {

                this._tripIntegrityHalt(
                    current,
                    null,
                    "CONFIRMED_PAYOUT_MISSING_SIGNATURE"
                );
            }

            const confirmedEvidence =
                this._evidence(
                    current
                );

            if (
                !confirmedEvidence.confirmed
            ) {

                this._tripIntegrityHalt(
                    current,
                    confirmedEvidence,
                    "CONFIRMED_PAYOUT_LOST_FINALITY"
                );
            }

            return {
                status:
                    "confirmed",
                batch: current,
                evidence:
                    confirmedEvidence
            };
        }

        const preEvidence =
            current.txSignature
                ? this._evidence(
                    current
                )
                : {
                    pending: false,
                    included: false,
                    confirmed: false,
                    confirmations: 0
                };

        if (
            preEvidence.confirmed
        ) {
            return this._finalizeIfConfirmed(
                current
            );
        }

        /*
         * Jest juz w canonical chain, ale nie ma wymaganej
         * liczby potwierdzen. Nie wysylamy jej ponownie.
         */
        if (
            preEvidence.included
        ) {

            if (
                current.state ===
                "reserved"
            ) {
                current =
                    this.ledger
                        .markSubmitted(
                            current.batchId
                        );
            }

            return {
                status:
                    "confirming",
                batch: current,
                evidence:
                    preEvidence
            };
        }

        if (
            preEvidence.pending
        ) {
            if (
                current.state ===
                "reserved"
            ) {
                current =
                    this.ledger
                        .markSubmitted(
                            current.batchId
                        );
            }

            return {
                status:
                    "pending",
                batch: current,
                evidence:
                    preEvidence
            };
        }

        current =
            this.ensureCandidate(
                current
            );

        if (
            current.state ===
            "reserved"
        ) {
            current =
                this.ledger
                    .markSubmitted(
                        current.batchId
                    );
        }

        /*
         * Od tego miejsca batch jest SUBMITTED PRZED siecia.
         *
         * Jesli proces padnie po wyslaniu requestu albo odpowiedz
         * zginie, kredyty pozostaja zarezerwowane, a restart uzyje
         * DOKLADNIE tego samego candidate/signature.
         */
        let outcome;

        try {
            outcome =
                await this.submitFn(
                    current.candidate
                );
        } catch (err) {
            outcome = {
                kind: "unknown",
                status: null,
                data: null,
                reason:
                    err &&
                    err.message
                        ? err.message
                        : String(err)
            };
        }

        current =
            this.ledger.getBatch(
                current.batchId
            );

        const postEvidence =
            this._evidence(
                current
            );

        if (
            postEvidence.confirmed
        ) {
            return this._finalizeIfConfirmed(
                current
            );
        }

        if (
            postEvidence.included
        ) {
            return {
                status:
                    "confirming",
                batch: current,
                outcome,
                evidence:
                    postEvidence
            };
        }

        if (
            postEvidence.pending
        ) {
            return {
                status:
                    "pending",
                batch: current,
                outcome,
                evidence:
                    postEvidence
            };
        }

        /*
         * FAIL-CLOSED DLA PODPISANEGO PAYOUTU:
         *
         * Od chwili, gdy candidate zostal podpisany i batch ma stan
         * submitted, ZADNA odpowiedz HTTP sama w sobie nie zwalnia
         * zarezerwowanych credits.
         *
         * Dotyczy to rowniez:
         * - HTTP 400,
         * - accepted:false,
         * - duplicate,
         * - 429 / 5xx,
         * - timeout,
         * - zerwanego polaczenia.
         *
         * HTTP opisuje tylko wynik konkretnej proby requestu.
         * Nie jest autorytatywnym dowodem, ze ta podpisana transakcja
         * nie istnieje i nie moze pojawic sie w lokalnym stanie.
         *
         * Automatyczny flow pozostawia batch jako submitted.
         * Ewentualne zwolnienie wymaga osobnego, jawnego reconciliation.
         */
        return {
            status:
                "submitted",
            batch: current,
            outcome,
            evidence:
                postEvidence
        };
    }

    async recoverActive() {

        this._assertNotHalted();

        const active =
            this.ledger
                .getActiveBatches();

        const results = [];

        for (
            const batch of active
        ) {
            results.push(
                await this.resolveBatch(
                    batch
                )
            );
        }

        return results;
    }

    async processReferralPending() {

        this._assertNotHalted();

        const pending =
            this.ledger
                .getReferralPending();

        const results = [];

        for (
            const batch of pending
        ) {
            const reward =
                this.referral.credit(
                    batch.minerAddress
                );

            /*
             * ReferralReward.credit() jest samo w sobie idempotentne.
             * Jesli proces padl po credit, ale przed tym markerem,
             * retry zwroci already-credited i bezpiecznie dotrze tutaj.
             */
            this.ledger
                .markReferralProcessed(
                    batch.batchId
                );

            results.push({
                batchId:
                    batch.batchId,
                minerAddress:
                    batch.minerAddress,
                reward
            });
        }

        return results;
    }

    async submitCurrent(
        minerAddress,
        cutoffMs
    ) {

        this._assertNotHalted();

        if (
            !ADDRESS_FORMAT.test(
                minerAddress
            ) ||
            minerAddress ===
                this.poolAddress
        ) {
            return {
                status:
                    "skipped"
            };
        }

        const batch =
            this.ledger
                .reserveCurrent({
                    batchId:
                        this.newBatchId(
                            "current"
                        ),
                    minerAddress,
                    fromAddress:
                        this.poolAddress,
                    cutoffMs,
                    minPayout:
                        this.minPayout,
                    fee:
                        this.fee,
                    txTimestamp:
                        this.now()
                });

        if (!batch) {
            return {
                status:
                    "nothing"
            };
        }

        if (
            Number(batch.amount) >
            this.maxSinglePayout
        ) {
            this.ledger.fail(
                batch.batchId,
                "MAX_SINGLE_PAYOUT"
            );

            throw new Error(
                "STOP: MAX_SINGLE_PAYOUT: " +
                Number(batch.amount) +
                " > " +
                this.maxSinglePayout +
                " dla " +
                minerAddress
            );
        }

        return this.resolveBatch(
            batch
        );
    }

    async submitLegacy(
        minerAddress,
        cutoffMs,
        maxAmount
    ) {
        this._assertNotHalted();

        if (
            !ADDRESS_FORMAT.test(
                minerAddress
            ) ||
            minerAddress ===
                this.poolAddress
        ) {
            return {
                status:
                    "skipped"
            };
        }

        const batch =
            this.ledger
                .reserveLegacy({
                    batchId:
                        this.newBatchId(
                            "legacy"
                        ),
                    minerAddress,
                    fromAddress:
                        this.poolAddress,
                    cutoffMs,
                    maxAmount,
                    fee:
                        this.fee,
                    txTimestamp:
                        this.now()
                });

        if (!batch) {
            return {
                status:
                    "nothing"
            };
        }

        if (
            Number(batch.amount) >
            this.maxSinglePayout
        ) {
            this.ledger.fail(
                batch.batchId,
                "MAX_SINGLE_PAYOUT"
            );

            throw new Error(
                "STOP: MAX_SINGLE_PAYOUT: " +
                Number(batch.amount) +
                " > " +
                this.maxSinglePayout +
                " dla " +
                minerAddress
            );
        }

        return this.resolveBatch(
            batch
        );
    }

    advanceLegacyBudget(
        rewardForHeight
    ) {
        if (
            typeof rewardForHeight !==
            "function"
        ) {
            throw new Error(
                "Brak rewardForHeight"
            );
        }

        const state =
            this.ledger.getState();

        if (!state) {
            throw new Error(
                "Brak payout_state"
            );
        }

        const heights =
            this.storage
                .getBlockHeightsSince(
                    state.lastCheckedHeight
                );

        if (
            heights.length === 0
        ) {
            return {
                advanced: false,
                added: 0,
                blocks: 0,
                state
            };
        }

        let added = 0;

        for (
            const height of heights
        ) {
            const reward =
                Number(
                    rewardForHeight(
                        height
                    )
                );

            if (
                !Number.isFinite(
                    reward
                ) ||
                reward < 0
            ) {
                throw new Error(
                    "Nieprawidlowa nagroda bloku"
                );
            }

            added +=
                reward;
        }

        const result =
            this.ledger
                .advanceLegacyBudget(
                    state.lastCheckedHeight,
                    heights[
                        heights.length -
                        1
                    ],
                    added
                );

        return {
            ...result,
            added:
                result.advanced
                    ? added
                    : 0,
            blocks:
                result.advanced
                    ? heights.length
                    : 0
        };
    }

    pendingPoolAddresses() {
        return new Set(
            this.storage
                .loadMempool()
                .filter(
                    (tx) =>
                        tx.from ===
                        this.poolAddress
                )
                .map(
                    (tx) =>
                        tx.to
                )
        );
    }

    async runCycle({
        cutoffTimestamp,
        rewardForHeight,
        legacyShare,
        minLegacyPayout
    }) {

        /*
         * MUST BE FIRST:
         * zanim recovery moze wykonac rebroadcast,
         * zanim referral zostanie zakredytowany,
         * zanim budzet zostanie naliczony
         * i zanim powstanie nowy payout.
         */
        this.auditConfirmedIntegrity();

        const recovered =
            await this.recoverActive();

        const referralsBefore =
            await this
                .processReferralPending();

        const budget =
            this.advanceLegacyBudget(
                (height) =>
                    legacyShare *
                    rewardForHeight(
                        height
                    )
            );

        const pendingAddresses =
            this.pendingPoolAddresses();

        const currentSummary =
            this.ledger
                .getAvailableSummary(
                    cutoffTimestamp
                )
                .filter(
                    (row) =>
                        Number(
                            row.currentTotal
                        ) > 0
                )
                .sort(
                    (a, b) =>
                        Number(
                            a.currentTotal
                        ) -
                        Number(
                            b.currentTotal
                        )
                );

        const currentResults = [];

        for (
            const row of
            currentSummary
        ) {
            if (
                pendingAddresses.has(
                    row.minerAddress
                )
            ) {
                continue;
            }

            const result =
                await this.submitCurrent(
                    row.minerAddress,
                    cutoffTimestamp
                );

            currentResults.push({
                minerAddress:
                    row.minerAddress,
                result
            });

            if (
                result.status ===
                    "pending" ||
                result.status ===
                    "submitted"
            ) {
                pendingAddresses.add(
                    row.minerAddress
                );
            }

            const reason =
                normalizeReason(
                    result.outcome &&
                    result.outcome.reason
                );

            if (
                result.status ===
                    "failed" &&
                (
                    reason.includes(
                        "niewystarczajace saldo"
                    ) ||
                    reason.includes(
                        "insufficient balance"
                    )
                )
            ) {
                break;
            }

            if (
                result.status !==
                    "nothing" &&
                this.delayMs > 0
            ) {
                await this.sleepFn(
                    this.delayMs
                );
            }
        }

        let legacyResult = null;

        const state =
            this.ledger.getState();

        if (
            state &&
            Number(
                state.accruedBudget
            ) >=
                minLegacyPayout
        ) {
            const legacySummary =
                this.ledger
                    .getAvailableSummary(
                        cutoffTimestamp
                    )
                    .filter(
                        (row) =>
                            Number(
                                row.legacyTotal
                            ) > 0
                    )
                    .sort(
                        (a, b) =>
                            Number(
                                a.legacyTotal
                            ) -
                            Number(
                                b.legacyTotal
                            )
                    );

            const target =
                legacySummary.find(
                    (row) =>
                        ADDRESS_FORMAT.test(
                            row.minerAddress
                        ) &&
                        row.minerAddress !==
                            this.poolAddress &&
                        !pendingAddresses.has(
                            row.minerAddress
                        )
                );

            if (target) {
                legacyResult =
                    await this.submitLegacy(
                        target.minerAddress,
                        cutoffTimestamp,
                        Number(
                            state.accruedBudget
                        )
                    );
            }
        }

        const referralsAfter =
            await this
                .processReferralPending();

        return {
            recovered,
            referralsBefore,
            budget,
            currentResults,
            legacyResult,
            referralsAfter
        };
    }
}

module.exports = {
    PayoutEngine,
    submitCandidateHttp,
    classifySubmission,
    normalizeReason
};
