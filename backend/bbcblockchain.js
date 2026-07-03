const crypto = require("crypto");
const CONFIG = require("./config");
const Storage = require("./storage");

// Maksymalna wartość 256-bitowego hasha - punkt odniesienia dla trudności/targetu
const MAX_TARGET = (1n << 256n) - 1n;

// Zamienia liczbę trudności na 64-znakowy hex target, do którego porównujemy hash.
// Im WYŻSZA trudność, tym MNIEJSZY target, tym trudniej go "trafić".
function difficultyToTargetHex(difficulty) {
    const safeDifficulty = BigInt(Math.max(1, Math.round(difficulty)));
    const target = MAX_TARGET / safeDifficulty;
    return target.toString(16).padStart(64, "0");
}

// Liczy hash bloku z jego pól. Samodzielna funkcja (nie metoda Block), żeby dało
// się nią walidować surowe rekordy przychodzące z sieci (JSON od peera), zanim
// jeszcze zdecydujemy, czy w ogóle zamienić je na obiekty Block.
function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    return crypto
        .createHash("sha256")
        .update(height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce)
        .digest("hex");
}

// Waliduje dowolną tablicę "rekordów bloków" (zwykłe obiekty, niekoniecznie
// instancje Block) - używane zarówno dla this.chain, jak i łańcucha otrzymanego
// od peera przez P2P, zanim go przyjmiemy. Genesis (i=0) NIE jest kopany, więc
// sprawdzamy dla niego tylko spójność hasha z treścią, bez wymogu trudności.
function isValidChainRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return false;

    const genesis = records[0];
    if (genesis.height !== 0 || genesis.previousHash !== "0".repeat(64)) return false;
    if (computeBlockHash(genesis) !== genesis.hash) return false;

    for (let i = 1; i < records.length; i++) {
        const b = records[i];
        const prev = records[i - 1];

        if (computeBlockHash(b) !== b.hash) return false;
        if (b.hash > difficultyToTargetHex(b.difficulty)) return false;
        if (b.previousHash !== prev.hash) return false;
        if (b.height !== prev.height + 1) return false;
        if (b.timestamp < prev.timestamp) return false;
    }
    return true;
}

// Genesis MUSI być deterministyczny - żeby dwa niezależnie odpalone węzły z tym
// samym config.js dały IDENTYCZNY hash bloku 0 (inaczej nigdy nie zsynchronizują
// się przez P2P, bo każdy "swój" genesis wygląda jak inna sieć). Dlatego stały
// znacznik czasu, a nie Date.now() przy starcie procesu.
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z

/**
 * Pojedynczy blok w łańcuchu. Zamiast pojedynczego "minerAddress" trzyma listę
 * transakcji - blok genesis niesie premine, każdy kolejny blok niesie transakcję
 * coinbase (nagrodę dla górnika).
 */
class Block {
    constructor({ height, timestamp, previousHash, transactions, difficulty }) {
        this.height = height;
        this.timestamp = timestamp;
        this.previousHash = previousHash;
        this.transactions = transactions;
        this.difficulty = difficulty;
        this.nonce = 0;
        this.hash = this.calculateHash();
    }

    calculateHash() {
        return computeBlockHash(this);
    }

    // Proof-of-work: szukamy hasha <= target (porównanie stringów działa poprawnie,
    // bo digest("hex") zawsze zwraca 64-znakowy string z wiodącymi zerami)
    mine(targetHex) {
        while (this.hash > targetHex) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this.hash;
    }

    // Odtwarza blok 1:1 z rekordu bazy danych (gotowy nonce/hash, bez ponownego
    // kopania). Zachowuje prototyp Block, więc calculateHash()/mine() nadal działają.
    static fromRecord({ height, timestamp, previousHash, transactions, difficulty, nonce, hash }) {
        const block = Object.create(Block.prototype);
        block.height = height;
        block.timestamp = timestamp;
        block.previousHash = previousHash;
        block.transactions = transactions;
        block.difficulty = difficulty;
        block.nonce = nonce;
        block.hash = hash;
        return block;
    }
}

/**
 * Łańcuch bloków: premine z configu, halving nagrody, pułap podaży,
 * trudność jako ciągła liczba z okresowym retargetingiem (nie co blok!).
 */
class Blockchain {
    constructor(dbPath = CONFIG.DATABASE) {
        this.storage = new Storage(dbPath);

        if (this.storage.hasBlocks()) {
            // Łańcuch już istnieje na dysku - wczytujemy go 1:1, genesis traktujemy
            // jako historyczny fakt (nie przeliczamy go na nowo z aktualnego configu,
            // bo config mógł się zmienić już po utworzeniu łańcucha)
            this.chain = this.storage.loadChain().map((record) => Block.fromRecord(record));
            this.difficulty = this.getLatestBlock().difficulty;
            this.actualPremine = this.chain[0].transactions.reduce((sum, tx) => sum + tx.amount, 0);

            console.log(
                `📦 Wczytano istniejący łańcuch z "${dbPath}" - ${this.chain.length} bloków, ` +
                    `wysokość ${this.getLatestBlock().height}`
            );
        } else {
            // Świeża baza - budujemy genesis z configu i od razu go zapisujemy
            this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
            this.actualPremine = (CONFIG.GENESIS_TRANSACTIONS || []).reduce(
                (sum, tx) => sum + tx.amount,
                0
            );
            if (this.actualPremine !== CONFIG.PREMINE) {
                console.warn(
                    `⚠️  PREMINE w config.js (${CONFIG.PREMINE}) nie zgadza się z sumą ` +
                        `GENESIS_TRANSACTIONS (${this.actualPremine}). Traktuję sumę transakcji ` +
                        `jako faktyczny premine - zaktualizuj config albo listę transakcji.`
                );
            }

            const genesis = this.createGenesisBlock();
            this.chain = [genesis];
            this.storage.saveBlock(genesis);

            console.log(`🌱 Nowy łańcuch - zapisano genesis blok do "${dbPath}"`);
        }
    }

    createGenesisBlock() {
        const transactions = (CONFIG.GENESIS_TRANSACTIONS || []).map((tx) => ({
            from: CONFIG.GENESIS_ADDRESS,
            to: tx.to,
            amount: tx.amount,
            type: "genesis"
        }));

        return new Block({
            height: 0,
            timestamp: GENESIS_TIMESTAMP,
            previousHash: "0".repeat(64),
            transactions,
            difficulty: this.difficulty
        });
    }

    getLatestBlock() {
        return this.chain[this.chain.length - 1];
    }

    // Nagroda za dany blok po uwzględnieniu halvingu i pułapu MAX_SUPPLY
    getRewardForHeight(height) {
        const halvings = Math.floor(height / CONFIG.HALVING_INTERVAL);
        const rawReward = CONFIG.BLOCK_REWARD / Math.pow(2, halvings);

        const remaining = CONFIG.MAX_SUPPLY - this.getCirculatingSupply();
        if (remaining <= 0) return 0;

        return Math.min(rawReward, remaining);
    }

    getCirculatingSupply() {
        let total = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                total += tx.amount;
            }
        }
        return total;
    }

    // Kopanie nowego bloku. Zwraca Promise, żeby dało się wywołać z `await`.
    // UWAGA: przy CONFIG.BLOCK_TIME rzędu minut i uczciwym retargetingu, kopanie
    // synchroniczne w handlerze requestu potrafi zablokować event loop na długo -
    // patrz komentarz przy maybeRetarget().
    async createNewBlock(minerAddress) {
        if (!minerAddress) {
            throw new Error("Brak adresu górnika");
        }

        const previousBlock = this.getLatestBlock();
        const height = previousBlock.height + 1;
        const reward = this.getRewardForHeight(height);

        const transactions = [
            { from: null, to: minerAddress, amount: reward, type: "coinbase" }
        ];

        const newBlock = new Block({
            height,
            timestamp: Date.now(),
            previousHash: previousBlock.hash,
            transactions,
            difficulty: this.difficulty
        });

        newBlock.mine(difficultyToTargetHex(this.difficulty));
        this.chain.push(newBlock);
        this.storage.saveBlock(newBlock);
        this.maybeRetarget();

        // wygodne skróty używane też przez server.js
        newBlock.reward = reward;
        newBlock.minerAddress = minerAddress;

        return newBlock;
    }

    // Retarguje trudność co CONFIG.DIFFICULTY_ADJUSTMENT bloków (nie co blok!),
    // na podstawie realnego czasu ostatniego okresu względem BLOCK_TIME.
    // Zmiana ograniczona do max 4x w górę / 4x w dół na raz (tak jak w Bitcoinie),
    // żeby jedno odchylenie nie wywindowało trudności do poziomu blokującego serwer.
    maybeRetarget() {
        const period = CONFIG.DIFFICULTY_ADJUSTMENT;
        const latest = this.getLatestBlock();
        if (latest.height === 0 || latest.height % period !== 0) return;

        const periodStart = this.chain[this.chain.length - 1 - period];
        if (!periodStart) return;

        const actualMs = latest.timestamp - periodStart.timestamp;
        const expectedMs = period * CONFIG.BLOCK_TIME * 1000;

        const ratio = Math.max(0.25, Math.min(4, expectedMs / actualMs));
        this.difficulty = Math.max(1, this.difficulty * ratio);
    }

    isChainValid() {
        return isValidChainRecords(this.chain);
    }

    // Przyjmuje POJEDYNCZY blok od peera, który bezpośrednio przedłuża nasz czubek
    // łańcucha (szybka ścieżka przy propagacji nowo wykopanego bloku - bez pełnej
    // resynchronizacji). Zwraca {accepted, reason?/block}.
    receiveBlock(record) {
        const latest = this.getLatestBlock();

        if (record.height !== latest.height + 1) {
            return {
                accepted: false,
                reason: `oczekiwano wysokości ${latest.height + 1}, dostałem ${record.height}`
            };
        }
        if (record.previousHash !== latest.hash) {
            return { accepted: false, reason: "previousHash nie pasuje do naszego czubka łańcucha" };
        }
        if (computeBlockHash(record) !== record.hash) {
            return { accepted: false, reason: "hash bloku nie zgadza się z jego zawartością" };
        }
        if (record.hash > difficultyToTargetHex(record.difficulty)) {
            return { accepted: false, reason: "hash nie spełnia deklarowanej trudności" };
        }

        const block = Block.fromRecord(record);
        this.chain.push(block);
        this.storage.saveBlock(block);
        this.maybeRetarget();

        return { accepted: true, block };
    }

    // Zastępuje CAŁY nasz łańcuch łańcuchem otrzymanym od peera (synchronizacja /
    // reguła "najdłuższy poprawny łańcuch wygrywa"). Przyjmuje tylko jeśli: ten sam
    // genesis (ta sama sieć), łańcuch w pełni poprawny i DŁUŻSZY niż nasz obecny.
    replaceChain(records) {
        if (!Array.isArray(records) || records.length <= this.chain.length) {
            return { accepted: false, reason: "otrzymany łańcuch nie jest dłuższy niż nasz" };
        }
        if (!records[0] || records[0].hash !== this.chain[0].hash) {
            return { accepted: false, reason: "inny blok genesis - to inna sieć" };
        }
        if (!isValidChainRecords(records)) {
            return { accepted: false, reason: "łańcuch zawiera nieprawidłowe/niespójne bloki" };
        }

        this.storage.replaceChain(records);
        this.chain = records.map((r) => Block.fromRecord(r));
        this.difficulty = this.getLatestBlock().difficulty;
        this.actualPremine = this.chain[0].transactions.reduce((sum, tx) => sum + tx.amount, 0);

        return { accepted: true, height: this.getLatestBlock().height };
    }

    // Saldo liczone z transakcji: genesis/coinbase tylko dopisują, "transfer"
    // (gdy powstanie mempool) będzie też odejmować z adresu nadawcy
    getBalance(address) {
        let balance = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to === address) balance += tx.amount;
                if (tx.type === "transfer" && tx.from === address) balance -= tx.amount;
            }
        }
        return balance;
    }

    getChain() {
        return this.chain;
    }

    // Bezpiecznie zamyka połączenie z bazą - wołać przy zamykaniu serwera (SIGINT/SIGTERM)
    close() {
        this.storage.close();
    }

    // Cienkie delegatory do rozliczeń puli kopania (pool.js) - blockchain zostaje
    // jedynym miejscem dotykającym storage bezpośrednio
    saveCredit(credit) {
        this.storage.saveCredit(credit);
    }

    getCredits(minerAddress) {
        return this.storage.getCredits(minerAddress);
    }

    getInfo() {
        const latest = this.getLatestBlock();
        const period = CONFIG.DIFFICULTY_ADJUSTMENT;

        return {
            network: CONFIG.NETWORK_NAME,
            symbol: CONFIG.SYMBOL,
            version: CONFIG.VERSION,
            chainId: CONFIG.CHAIN_ID,
            height: latest.height,
            latestHash: latest.hash,
            difficulty: Math.round(this.difficulty),
            difficultyLeadingZerosApprox: Number((Math.log2(this.difficulty) / 4).toFixed(2)),
            totalBlocks: this.chain.length,
            currentBlockReward: this.getRewardForHeight(latest.height + 1),
            circulatingSupply: this.getCirculatingSupply(),
            maxSupply: CONFIG.MAX_SUPPLY,
            premine: this.actualPremine,
            blocksUntilHalving: CONFIG.HALVING_INTERVAL - (latest.height % CONFIG.HALVING_INTERVAL),
            blocksUntilRetarget: period - (latest.height % period),
            isValid: this.isChainValid()
        };
    }
}

module.exports = Blockchain;
module.exports.Block = Block;
module.exports.difficultyToTargetHex = difficultyToTargetHex;
module.exports.computeBlockHash = computeBlockHash;
module.exports.isValidChainRecords = isValidChainRecords;
