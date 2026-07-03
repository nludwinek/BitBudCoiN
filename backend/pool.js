const CONFIG = require("./config");
const { computeBlockHash, difficultyToTargetHex } = require("./bbcblockchain");

const MAX_SEEN_SHARE_HASHES = 20000;

/**
 * Pula kopania: górnik SAM liczy hashe (u siebie, na własnym sprzęcie) i wysyła
 * kandydatów ("shares") do weryfikacji, zamiast serwer robił to synchronicznie
 * w środku requestu jak /mine/start. To jedyny sposób, żeby CONFIG.BLOCK_TIME
 * rzędu minut nie blokował event loopa serwera.
 *
 * share = hash spełniający ŁATWY SHARE_DIFFICULTY - dowód pracy, zdarza się często
 * blok  = hash DODATKOWO spełniający pełny (sieciowy) DIFFICULTY - rzadki, kończy rundę
 *
 * WAŻNE OGRANICZENIE: coinbase w faktycznie wykopanym bloku zawsze płaci na
 * CONFIG.POOL_ADDRESS - tak to działa w prawdziwych pulach, bo tylko WSPÓLNY
 * szablon (ten sam hash do policzenia) pozwala wielu górnikom pracować nad tym
 * samym blokiem. Podział między górników jest liczony TUTAJ jako "należność"
 * (pool_credits) - realna WYPŁATA na indywidualne adresy górników wymaga systemu
 * transakcji/mempoola (kolejny temat z configu, jeszcze niezbudowany). Na razie
 * to widoczny, policzony dług, nie automatyczny przelew.
 */
class MiningPool {
    constructor(blockchain, { poolAddress, poolFee, shareDifficulty } = {}) {
        this.blockchain = blockchain;
        this.poolAddress = poolAddress ?? CONFIG.POOL_ADDRESS;
        this.poolFee = poolFee ?? CONFIG.POOL_FEE;
        this.shareDifficulty = Math.pow(16, shareDifficulty ?? CONFIG.SHARE_DIFFICULTY);

        this.roundShares = new Map(); // minerAddress -> liczba shares w BIEŻĄCEJ rundzie
        this.seenShareHashes = new Set(); // ochrona przed powtórnym zgłoszeniem tego samego hasha
    }

    // Świeży szablon pracy - liczony na bieżąco z AKTUALNEGO czubka łańcucha przy
    // każdym wywołaniu (nie cache'owany), więc samoczynnie "leczy się" po zmianach
    // z P2P czy po /mine/start - zero osobnej logiki unieważniania.
    getWork(minerAddress) {
        const latest = this.blockchain.getLatestBlock();
        const height = latest.height + 1;
        const reward = this.blockchain.getRewardForHeight(height);
        const blockDifficulty = this.blockchain.difficulty;

        const transactions = [
            { from: null, to: this.poolAddress, amount: reward, type: "coinbase" }
        ];

        return {
            height,
            previousHash: latest.hash,
            timestamp: Date.now(),
            transactions,
            difficulty: blockDifficulty,
            shareTarget: difficultyToTargetHex(this.shareDifficulty),
            blockTarget: difficultyToTargetHex(blockDifficulty),
            requestedBy: minerAddress ?? null
        };
    }

    // Miner odsyła kandydata, na którym pracował: te same pola co z getWork(),
    // plus nonce i wynikowy hash. Serwer NIGDY nie ufa hashowi od klienta -
    // zawsze przelicza sam.
    submitShare(minerAddress, candidate) {
        if (!minerAddress) return { accepted: false, reason: "Brak adresu górnika" };
        if (!candidate || typeof candidate.hash !== "string") {
            return { accepted: false, reason: "Nieprawidłowe zgłoszenie" };
        }

        const recomputed = computeBlockHash(candidate);
        if (recomputed !== candidate.hash) {
            return { accepted: false, reason: "hash nie zgadza się z treścią (nieprawidłowe zgłoszenie)" };
        }

        if (this.seenShareHashes.has(candidate.hash)) {
            return { accepted: false, reason: "ten hash już został zgłoszony (duplikat)" };
        }

        const shareTargetHex = difficultyToTargetHex(this.shareDifficulty);
        if (candidate.hash > shareTargetHex) {
            return { accepted: false, reason: "hash nie spełnia nawet trudności share" };
        }

        // od tej linii share jest ważny i liczy się do rundy, niezależnie od dalszego przebiegu
        this._rememberShareHash(candidate.hash);
        this.roundShares.set(minerAddress, (this.roundShares.get(minerAddress) || 0) + 1);

        const blockTargetHex = difficultyToTargetHex(candidate.difficulty);
        const isFullBlock = candidate.hash <= blockTargetHex;

        if (!isFullBlock) {
            return { accepted: true, share: true, blockFound: false };
        }

        // share okazał się DODATKOWO pełnoprawnym blokiem - próbujemy dopiąć do łańcucha
        const result = this.blockchain.receiveBlock(candidate);
        if (!result.accepted) {
            // ktoś inny (np. przez P2P) zdążył wcześniej na tę wysokość - share nadal
            // ważny i policzony, ale bez finalizacji rundy/wypłaty za TEN blok
            return {
                accepted: true,
                share: true,
                blockFound: false,
                note: `blok spóźniony, ktoś był szybszy: ${result.reason}`
            };
        }

        const payouts = this._finalizeRound(result.block);
        return { accepted: true, share: true, blockFound: true, block: result.block, payouts };
    }

    _rememberShareHash(hash) {
        if (this.seenShareHashes.size > MAX_SEEN_SHARE_HASHES) this.seenShareHashes.clear();
        this.seenShareHashes.add(hash);
    }

    _finalizeRound(block) {
        const coinbase = block.transactions.find((tx) => tx.type === "coinbase");
        const totalReward = coinbase ? coinbase.amount : 0;
        const distributable = totalReward * (1 - this.poolFee);

        const totalShares = Array.from(this.roundShares.values()).reduce((a, b) => a + b, 0);

        const payouts = [];
        if (totalShares > 0) {
            for (const [minerAddress, shares] of this.roundShares) {
                const amount = distributable * (shares / totalShares);
                this.blockchain.saveCredit({
                    minerAddress,
                    blockHeight: block.height,
                    shares,
                    amount,
                    timestamp: Date.now()
                });
                payouts.push({ minerAddress, shares, amount });
            }
        }

        this.roundShares = new Map();
        return payouts;
    }

    getStatus() {
        const latest = this.blockchain.getLatestBlock();
        return {
            poolAddress: this.poolAddress,
            poolFee: this.poolFee,
            workingOnHeight: latest.height + 1,
            shareDifficulty: Math.round(this.shareDifficulty),
            blockDifficulty: Math.round(this.blockchain.difficulty),
            sharesThisRound: Object.fromEntries(this.roundShares),
            totalSharesThisRound: Array.from(this.roundShares.values()).reduce((a, b) => a + b, 0)
        };
    }

    getCredits(minerAddress) {
        return this.blockchain.getCredits(minerAddress);
    }
}

module.exports = MiningPool;
