// =====================================================
// BitBudCoin Core
// mempool.js vMax
// =====================================================

class Mempool {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.transactions = [];
    }

    addTransaction(tx) {
        // 1. podpis
        if (!tx.isSignatureValid()) {
            throw new Error("Invalid transaction signature");
        }

        // 2. balans
        if (tx.from !== null) {
            const balance = this.blockchain.getBalance(tx.from);
            const totalCost = tx.amount + (tx.fee || 0);

            if (balance < totalCost) {
                throw new Error("Insufficient balance");
            }
        }

        // 3. prosta ochrona przed duplikatami
        const exists = this.transactions.find(
            (t) => t.txid === tx.txid
        );
        if (exists) {
            throw new Error("Transaction already in mempool");
        }

        this.transactions.push(tx);
    }

    removeTransaction(txid) {
        this.transactions = this.transactions.filter(
            (tx) => tx.txid !== txid
        );
    }

    clear() {
        this.transactions = [];
    }
}

module.exports = Mempool;