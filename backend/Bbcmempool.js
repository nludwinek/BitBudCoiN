const CONFIG = require("./config");
const { verifyTransactionSignature } = require("./wallet");

/**
 * Pula oczekujących, jeszcze niewykopanych transakcji. Trzymana w pamięci +
 * lustrzanie w bazie (przeżywa restart). Identyfikator transakcji = jej podpis
 * (unikalny per treść+klucz, stabilny niezależnie od tego, w jakim kształcie
 * obiekt akurat krąży - w mempoolu, w bloku, w wiadomości P2P).
 */
class Mempool {
    constructor(blockchain, storage) {
        this.blockchain = blockchain;
        this.storage = storage;
        this.pending = new Map(); // signature -> transakcja

        for (const tx of this.storage.loadMempool()) {
            this.pending.set(tx.signature, tx);
        }
        if (this.pending.size > 0) {
            console.log(`📥 Wczytano ${this.pending.size} oczekujących transakcji z bazy`);
        }
    }

    // Potwierdzone saldo pomniejszone o WŁASNE oczekujące transakcje nadawcy -
    // żeby nie dało się wysłać dwóch przelewów, które razem przekraczają saldo
    getPendingAwareBalance(address) {
        let balance = this.blockchain.getBalance(address);
        for (const tx of this.pending.values()) {
            if (tx.from === address) balance -= tx.amount + tx.fee;
        }
        return balance;
    }

    addTransaction(tx) {
        if (!tx || typeof tx.amount !== "number" || !(tx.amount > 0)) {
            return { accepted: false, reason: "Nieprawidłowa kwota" };
        }
        const fee = typeof tx.fee === "number" ? tx.fee : 0;
        if (fee < CONFIG.MIN_FEE) {
            return { accepted: false, reason: `Opłata poniżej minimalnej (${CONFIG.MIN_FEE})` };
        }
        if (!tx.from || !tx.to) {
            return { accepted: false, reason: "Brak adresu nadawcy/odbiorcy" };
        }
        if (tx.from === tx.to) {
            return { accepted: false, reason: "Nadawca i odbiorca są tacy sami" };
        }
        if (!verifyTransactionSignature(tx)) {
            return { accepted: false, reason: "Nieprawidłowy podpis - transakcja odrzucona" };
        }
        if (this.pending.has(tx.signature)) {
            return { accepted: false, reason: "Ta transakcja już jest w mempoolu" };
        }

        const available = this.getPendingAwareBalance(tx.from);
        if (available < tx.amount + fee) {
            return {
                accepted: false,
                reason: `Niewystarczające saldo (dostępne z uwzględnieniem oczekujących: ${available})`
            };
        }

        const record = {
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            fee,
            timestamp: tx.timestamp,
            publicKey: tx.publicKey,
            signature: tx.signature,
            receivedAt: Date.now()
        };

        this.pending.set(record.signature, record);
        this.storage.saveMempoolTx(record);
        return { accepted: true, signature: record.signature };
    }

    // Wybiera transakcje do bloku: najwyższa opłata pierwsza, do limitu z configu,
    // pomijając te, które by się już nie zbilansowały względem POTWIERDZONEGO salda
    // (np. nadawca ma kilka transakcji w mempoolu, ale nie starcza na wszystkie naraz).
    selectForBlock() {
        const candidates = Array.from(this.pending.values()).sort((a, b) => b.fee - a.fee);
        const selected = [];
        const spentSoFar = new Map();

        for (const tx of candidates) {
            if (selected.length >= CONFIG.MAX_TRANSACTIONS_PER_BLOCK) break;

            const confirmed = this.blockchain.getBalance(tx.from);
            const already = spentSoFar.get(tx.from) || 0;
            const need = tx.amount + tx.fee;
            if (confirmed - already < need) continue;

            spentSoFar.set(tx.from, already + need);
            selected.push(tx);
        }

        return selected;
    }

    // Usuwa z mempoola transakcje, które właśnie trafiły do potwierdzonego bloku
    // (dowolne źródło: solo mining, pula, P2P) - dopasowanie po podpisie
    pruneConfirmed(block) {
        for (const tx of block.transactions) {
            if (tx.type === "transfer" && this.pending.has(tx.signature)) {
                this.pending.delete(tx.signature);
                this.storage.deleteMempoolTx(tx.signature);
            }
        }
    }

    // Po większej reorganizacji łańcucha (replaceChain) - usuwa transakcje, które
    // już się nie bilansują względem NOWEGO potwierdzonego salda. Uproszczenie:
    // transakcje z odrzuconej gałęzi nie wracają automatycznie do mempoola,
    // nadawca musiałby wysłać ponownie.
    revalidateAll() {
        for (const [signature, tx] of Array.from(this.pending.entries())) {
            if (this.blockchain.getBalance(tx.from) < tx.amount + tx.fee) {
                this.pending.delete(signature);
                this.storage.deleteMempoolTx(signature);
            }
        }
    }

    getPending() {
        return Array.from(this.pending.values());
    }
}

module.exports = Mempool;
