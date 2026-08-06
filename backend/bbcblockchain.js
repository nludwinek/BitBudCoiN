const crypto = require("crypto");
const CONFIG = require("./config");
const Storage = require("./storage");
const MAX_TARGET = (1n << 256n) - 1n;
const GENESIS_TIMESTAMP = Date.UTC(2026, 0, 1);
// Opłata protokołu - usztywniona w kodzie, nie w configu (patrz poprzednia
// zmiana). Bez ruszania tego dzisiaj.
const PROJECT_FEE_PERCENT = 0.005;
function difficultyToTargetHex(difficulty) {
    const safe = BigInt(Math.max(1, Math.round(difficulty)));
    return (MAX_TARGET / safe).toString(16).padStart(64, "0");
}
function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    return crypto.createHash("sha256")
        .update(height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce)
        .digest("hex");
}
function sha256Hex(input) {
    return crypto.createHash("sha256").update(input).digest("hex");
}
class Block {
    constructor({ height, timestamp, previousHash, transactions, difficulty, nonce = 0 }) {
        Object.assign(this, { height, timestamp, previousHash, transactions, difficulty, nonce });
        this.hash = this.calculateHash();
    }
    calculateHash() { return computeBlockHash(this); }
    mine(targetHex) {
        while (this.hash > targetHex) {
            this.nonce++;
            this.hash = this.calculateHash();
        }
        return this.hash;
    }
}
function isProjectFeeActive(height) {
    return !!(CONFIG.PROJECT_FEE_ADDRESS &&
        CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT !== undefined &&
        height >= CONFIG.PROJECT_FEE_ACTIVATION_HEIGHT);
}
class Blockchain {
    constructor() {
        this.storage = new Storage(CONFIG.DATABASE);
        // BEZPIECZEŃSTWO (31.07.2026, zaktualizowane 05.08.2026 przy dodaniu
        // retargetingu): trudność NIGDY nie jest wczytywana z zapisanych
        // bloków ani od tego, kto zgłasza blok - to pole może być
        // sfałszowane (patrz poprawka w receiveBlock() niżej - realny
        // incydent, nie teoria: ktoś zgłaszał bloki z zaniżoną trudnością,
        // ~550x szybciej niż powinno wychodzić). Start ZAWSZE z tej samej
        // stałej co przy genesis. this.difficulty MOŻE się teraz zmieniać w
        // czasie działania przez retargetIfDue() niżej - ale WYŁĄCZNIE
        // licząc z historii WŁASNEGO, już zweryfikowanego łańcucha, nigdy z
        // danych przysłanych z zewnątrz.
        this.difficulty = Math.pow(16, CONFIG.DIFFICULTY);
        if (this.storage.hasRawChain()) {
            this.chain = this.storage.loadRawChain();
            this._warnIfChainHasGaps();

            if (this.storage.getMeta("legacySnapshot", false) === true) {
                const storedDifficulty = Number(
                    this.storage.getMeta(
                        "networkDifficulty",
                        this.getLatestBlock().difficulty
                    )
                );

                if (!Number.isFinite(storedDifficulty) || storedDifficulty <= 0) {
                    throw new Error("Nieprawidłowa trudność zapisana dla legacy snapshot");
                }

                this.difficulty = storedDifficulty;
                this.storage.setMeta("networkDifficulty", this.difficulty);
            } else {
                this._recomputeDifficultyFromHistory();
            }
        } else if (this.storage.hasBlocks()) {
            this.chain = this.storage.loadChain();

            // Pierwsze uruchomienie po aktualizacji:
            // zachowaj dotychczasowy łańcuch również jako dokładny JSON.
            this.storage.replaceRawChain(this.chain);

            this._warnIfChainHasGaps();
            this._recomputeDifficultyFromHistory();
        } else {
            const transactions = CONFIG.GENESIS_TRANSACTIONS.map((tx) => ({
                from: CONFIG.GENESIS_ADDRESS, to: tx.to, amount: tx.amount, type: "genesis"
            }));
            const genesis = new Block({
                height: 0, timestamp: GENESIS_TIMESTAMP, previousHash: "0".repeat(64),
                transactions, difficulty: this.difficulty
            });
            this.chain = [genesis];
            this.storage.saveBlockWithRaw(genesis);
        }
    }
    getLatestBlock() { return this.chain[this.chain.length - 1]; }
    getRewardForHeight(height) {
        return CONFIG.BLOCK_REWARD / Math.pow(2, Math.floor(height / CONFIG.HALVING_INTERVAL));
    }
    // Buduje listę transakcji do nowego bloku. HTLC_CREATE/CLAIM/REFUND
    // ZACHOWUJĄ swój prawdziwy typ i pola (poprzednio WSZYSTKO trafiało jako
    // "transfer", gubiąc htlcId/hashLock/claimant/itd. - to była realna luka,
    // przez którą /htlc/submit nie miałby jak w ogóle zadziałać, nawet gdyby
    // istniał).
    buildBlockTransactions(rewardRecipient, pendingTransactions = []) {
        const height = this.getLatestBlock().height + 1;
        const reward = this.getRewardForHeight(height);
        const transactions = [{ from: null, to: rewardRecipient, amount: reward, type: "coinbase" }];
        const feeActive = isProjectFeeActive(height);
        let totalMinerFees = 0;
        let totalProtocolCut = 0;
        for (const tx of pendingTransactions) {
            if (tx.type === "HTLC_CREATE") {
                transactions.push({
                    htlcId: tx.htlcId, from: tx.from, to: tx.claimant, amount: tx.amount, fee: tx.fee,
                    hashLock: tx.hashLock, timeoutHeight: tx.timeoutHeight,
                    claimant: tx.claimant, refundee: tx.refundee,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_CREATE"
                });
                totalMinerFees += (tx.fee || 0);
                if (feeActive) totalProtocolCut += tx.amount * PROJECT_FEE_PERCENT;
            } else if (tx.type === "HTLC_CLAIM") {
                // tx.to/tx.amount dopisane PRZEZ server.js z wyniku
                // validateHTLCClaim() PRZED trafieniem do mempoola - sam
                // podpisany payload (z portfela) tego nie zawiera.
                transactions.push({
                    htlcId: tx.htlcId, claimant: tx.claimant, secret: tx.secret,
                    to: tx.to, amount: tx.amount,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_CLAIM"
                });
            } else if (tx.type === "HTLC_REFUND") {
                transactions.push({
                    htlcId: tx.htlcId, refundee: tx.refundee,
                    to: tx.to, amount: tx.amount,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature,
                    type: "HTLC_REFUND"
                });
            } else {
                transactions.push({
                    from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee,
                    timestamp: tx.timestamp, publicKey: tx.publicKey, signature: tx.signature, type: "transfer"
                });
                totalMinerFees += (tx.fee || 0);
                if (feeActive) totalProtocolCut += tx.amount * PROJECT_FEE_PERCENT;
            }
        }
        if (totalMinerFees > 0 && CONFIG.PROJECT_FEE_ADDRESS) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalMinerFees, type: "fee" });
        }
        if (totalProtocolCut > 0) {
            transactions.push({ from: null, to: CONFIG.PROJECT_FEE_ADDRESS, amount: totalProtocolCut, type: "protocol_fee" });
        }
        return transactions;
    }
    receiveBlock(candidate) {
        const latest = this.getLatestBlock();
        if (candidate.height !== latest.height + 1) return { accepted: false, reason: "wysokość nie pasuje" };
        if (candidate.previousHash !== latest.hash) return { accepted: false, reason: "previousHash nie pasuje" };
        if (computeBlockHash(candidate) !== candidate.hash) return { accepted: false, reason: "hash się nie zgadza" };
        // BEZPIECZEŃSTWO (31.07.2026): candidate.difficulty pochodzi od tego,
        // kto ZGŁASZA blok - bez tego sprawdzenia dało się wpisać dowolnie
        // niską wartość, robiąc próg trudności absurdalnie łatwym, mimo że
        // /info dalej pokazywałoby prawdziwą, wysoką trudność sieci. Realny
        // incydent 31.07.2026 (~550x przyspieszenie kopania), nie teoria.
        if (candidate.difficulty !== this.difficulty) {
            return { accepted: false, reason: `nieprawidłowa trudność (oczekiwano ${this.difficulty}, otrzymano ${candidate.difficulty})` };
        }
        if (candidate.hash > difficultyToTargetHex(candidate.difficulty)) return { accepted: false, reason: "nie spełnia trudności" };
        // SPÓJNOŚĆ (05.08.2026): zapis do bazy MUSI się udać PRZED dodaniem
        // bloku do this.chain. Wcześniej push() szedł PIERWSZY - jeśli
        // saveBlock() rzucił (np. transakcja z to_address=null łamiąca
        // NOT NULL w SQLite), blok zostawał w pamięci jako "widmo", którego
        // baza nigdy nie miała. Po restarcie loadChain() czyta czystą bazę
        // bez tego wpisu - to była realna przyczyna dziury w łańcuchu
        // (bloki 3497 i 3614 zniknęły dokładnie tak, bez żadnego błędu w
        // logach, bo wyjątek nigdy nie docierał do nikogo, kto by go
        // zauważył).
        try {
            this.storage.saveBlockWithRaw(candidate);
        } catch (err) {
            return { accepted: false, reason: "błąd zapisu do bazy: " + err.message };
        }
        this.chain.push(candidate);
        this.retargetIfDue(candidate);

        // Zachowaj aktualną trudność także po ewentualnym retargetingu,
        // aby restart nie wymagał przeliczania wadliwej historii legacy.
        this.storage.setMeta("networkDifficulty", this.difficulty);

        return { accepted: true, block: candidate };
    }
    // Wywoływane PO udanym zapisaniu każdego bloku. Jeśli właśnie przyjęty
    // blok kończy okno przeliczania (jego wysokość jest wielokrotnością
    // CONFIG.DIFFICULTY_ADJUSTMENT), porównuje jak długo NAPRAWDĘ zajęło
    // wykopanie tych bloków względem tego, ile powinno zająć (przy
    // CONFIG.TARGET_BLOCK_TIME_MS) i proporcjonalnie dostosowuje
    // this.difficulty dla WSZYSTKICH kolejnych bloków. Zmiana ograniczona do
    // max 4x w górę i max 4x w dół na jedno okno, żeby jeden dziwny odczyt
    // zegara albo chwilowy skok hashrate'u nie wywrócił trudności do zera
    // albo w kosmos. Blok #0 (genesis) nigdy nie wyzwala przeliczenia - nie
    // ma go z czym porównać.
    retargetIfDue(justAccepted) {
        const interval = CONFIG.DIFFICULTY_ADJUSTMENT;
        if (justAccepted.height === 0 || justAccepted.height % interval !== 0) return;

        const windowStart = this.chain.find((b) => b.height === justAccepted.height - interval);
        if (!windowStart) return; // za mało historii (np. świeżo zsynchronizowany węzeł)

        const actualMs = Math.max(1, justAccepted.timestamp - windowStart.timestamp);
        const expectedMs = interval * CONFIG.TARGET_BLOCK_TIME_MS;

        let ratio = expectedMs / actualMs;
        ratio = Math.max(0.25, Math.min(4, ratio));

        this.difficulty = Math.max(1, this.difficulty * ratio);
    }
    // Wywoływane RAZ przy starcie, zaraz po loadChain(). this.difficulty
    // zaczyna zawsze od tej samej stałej bazowej (patrz konstruktor) - bez
    // tego kroku węzeł po restarcie miałby INNĄ lokalną trudność niż węzeł,
    // który działał bez przerwy, mimo identycznego łańcucha. Dwa węzły z
    // różną lokalną trudnością odrzucają nawzajem swoje bloki jako
    // "nieprawidłowa trudność" - to realne ryzyko forka między
    // 141.147.98.57 a węzłem kolegi po restarcie, nie tylko czystość kodu.
    // Rozwiązanie: przewinąć wszystkie okna retargetingu, które już minęły
    // w załadowanej historii, dokładnie tak samo jak działyby się na żywo.
    _recomputeDifficultyFromHistory() {
        const interval = CONFIG.DIFFICULTY_ADJUSTMENT;
        const latestHeight = this.getLatestBlock().height;
        for (let h = interval; h <= latestHeight; h += interval) {
            const block = this.chain.find((b) => b.height === h);
            if (block) this.retargetIfDue(block);
        }
    }
    // Wywoływane RAZ przy starcie. NIE naprawia dziur (to wymaga ręcznego
    // odzyskania brakujących bloków, np. z nocnego backupu) - tylko krzyczy
    // o nich głośno w logach, zamiast pozwolić im siedzieć niezauważone
    // miesiącami tak jak bloki 3497 i 3614.
    _warnIfChainHasGaps() {
        for (let i = 1; i < this.chain.length; i++) {
            const expected = this.chain[i - 1].height + 1;
            if (this.chain[i].height !== expected) {
                const missingEnd = this.chain[i].height - 1;
                const label = expected === missingEnd ? `${expected}` : `${expected}-${missingEnd}`;
                console.error(`⚠️  DZIURA W ŁAŃCUCHU: brakuje bloku/bloków ${label} (baza przeskakuje z wysokości ${this.chain[i - 1].height} na ${this.chain[i].height})`);
            }
        }
    }
    replaceChain(candidateChain, remoteAddr = "") {
        if (!Array.isArray(candidateChain) || candidateChain.length < 2) {
            return { accepted: false, reason: "łańcuch jest pusty lub nieprawidłowy" };
        }

        const localLatest = this.getLatestBlock();
        const candidateLatest = candidateChain[candidateChain.length - 1];

        if (!candidateLatest || candidateLatest.height <= localLatest.height) {
            return { accepted: false, reason: "łańcuch nie jest dłuższy" };
        }

        const remoteHost = String(remoteAddr)
            .replace(/^::ffff:/, "")
            .split(":")[0];

        const trustedHost = String(CONFIG.TRUSTED_LEGACY_PEER || "")
            .replace(/^::ffff:/, "")
            .split(":")[0];

        const isTrustedPeer =
            remoteHost === trustedHost;

        const isInitialLegacyBootstrap =
            localLatest.height === 0 &&
            isTrustedPeer;

        const isLegacyContinuation =
            localLatest.height > 0 &&
            this.storage.getMeta("legacySnapshot", false) === true &&
            isTrustedPeer;

        // Po restarcie peer nadal wysyła pełny CHAIN.
        // Nie przyjmujemy ponownie całej historii. Znajdujemy lokalny tip
        // i rygorystycznie walidujemy wyłącznie nowe bloki po nim.
        if (isLegacyContinuation) {
            const anchorIndex = candidateChain.findIndex((block) =>
                block &&
                block.height === localLatest.height &&
                block.hash === localLatest.hash
            );

            if (anchorIndex === -1) {
                return {
                    accepted: false,
                    reason: `łańcuch peera nie zawiera lokalnego checkpointu ${localLatest.height}`
                };
            }

            const suffix = candidateChain.slice(anchorIndex + 1);

            if (suffix.length === 0) {
                return {
                    accepted: false,
                    reason: "peer nie posiada nowych bloków"
                };
            }

            let appended = 0;

            for (const block of suffix) {
                const result = this.receiveBlock(block);

                if (!result.accepted) {
                    return {
                        accepted: false,
                        reason: `odrzucono nowy blok ${block?.height}: ${result.reason}`,
                        appended
                    };
                }

                appended++;
            }

            this.storage.setMeta(
                "strictValidatedHeight",
                this.getLatestBlock().height
            );

            return {
                accepted: true,
                height: this.getLatestBlock().height,
                legacySnapshot: true,
                strictContinuation: true,
                appended
            };
        }

        if (!isInitialLegacyBootstrap) {
            return {
                accepted: false,
                reason: "pełna synchronizacja legacy dozwolona tylko przy pierwszym uruchomieniu i od zaufanego peera"
            };
        }

        const localGenesis = this.chain[0];
        const remoteGenesis = candidateChain[0];

        if (
            !remoteGenesis ||
            remoteGenesis.height !== 0 ||
            remoteGenesis.hash !== localGenesis.hash
        ) {
            return { accepted: false, reason: "genesis nie pasuje" };
        }

        let previousHeight = -1;
        let missingHeights = 0;
        let hashMismatches = 0;
        let brokenLinks = 0;

        for (let i = 0; i < candidateChain.length; i++) {
            const block = candidateChain[i];

            if (
                !block ||
                !Number.isInteger(block.height) ||
                !Number.isFinite(block.timestamp) ||
                !Array.isArray(block.transactions) ||
                typeof block.previousHash !== "string" ||
                typeof block.hash !== "string" ||
                !Number.isFinite(block.difficulty) ||
                !Number.isFinite(block.nonce)
            ) {
                return {
                    accepted: false,
                    reason: `nieprawidłowa struktura bloku na pozycji ${i}`
                };
            }

            if (block.height <= previousHeight) {
                return {
                    accepted: false,
                    reason: `wysokości nie rosną przy bloku ${block.height}`
                };
            }

            if (i > 0) {
                const previous = candidateChain[i - 1];
                const gap = block.height - previous.height - 1;

                if (gap > 0) {
                    missingHeights += gap;
                } else if (block.previousHash !== previous.hash) {
                    brokenLinks++;
                    return {
                        accepted: false,
                        reason: `zerwany link między blokiem ${previous.height} i ${block.height}`
                    };
                }
            }

            const calculatedHash = computeBlockHash(block);

            if (calculatedHash !== block.hash) {
                hashMismatches++;
            }

            // Genesis ma ustalony historyczny hash i nie podlega
            // standardowej walidacji Proof of Work.
            if (
                block.height !== 0 &&
                block.hash > difficultyToTargetHex(block.difficulty)
            ) {
                return {
                    accepted: false,
                    reason: `blok ${block.height} nie spełnia zapisanej trudności`
                };
            }

            previousHeight = block.height;
        }

        try {
            this.storage.replaceRawChain(candidateChain);

            this.storage.setMeta("legacySnapshot", true);
            this.storage.setMeta("legacyCheckpointHeight", candidateLatest.height);
            this.storage.setMeta("legacyMissingHeights", missingHeights);
            this.storage.setMeta("legacyHashMismatches", hashMismatches);
            this.storage.setMeta("legacyBrokenLinks", brokenLinks);
            this.storage.setMeta("legacySourcePeer", remoteHost);
            this.storage.setMeta("legacyAcceptedAt", Date.now());
        } catch (err) {
            return {
                accepted: false,
                reason: "błąd zapisu legacy snapshot: " + err.message
            };
        }

        this.chain = candidateChain;

        const checkpointDifficulty = Number(candidateLatest.difficulty);

        if (!Number.isFinite(checkpointDifficulty) || checkpointDifficulty <= 0) {
            return {
                accepted: false,
                reason: "checkpoint zawiera nieprawidłową trudność"
            };
        }

        // Historia legacy ma luki, dlatego nie wolno odtwarzać z niej
        // bieżącej trudności. Kotwiczymy stan z ostatniego bloku snapshotu.
        this.difficulty = checkpointDifficulty;
        this.storage.setMeta("networkDifficulty", this.difficulty);

        this._warnIfChainHasGaps();

        console.warn(
            `⚠️  Przyjęto LEGACY SNAPSHOT do wysokości ${candidateLatest.height}; ` +
            `brakujące wysokości: ${missingHeights}; ` +
            `historyczne niezgodności hashy: ${hashMismatches}`
        );

        return {
            accepted: true,
            height: candidateLatest.height,
            legacySnapshot: true,
            missingHeights,
            hashMismatches
        };
    }

    getChain() { return this.chain; }
    getRecentBlocks(limit = 20, beforeHeight = null) {
        let blocks = this.chain.slice().reverse();
        if (beforeHeight !== null) blocks = blocks.filter((b) => b.height < beforeHeight);
        return blocks.slice(0, limit);
    }
    // ============ HTLC (Hash Time-Locked Contracts) ============
    findHTLC(htlcId) {
        let created = null;
        let resolvedStatus = null;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "HTLC_CREATE" && tx.htlcId === htlcId) {
                    created = { ...tx, createdAtHeight: block.height };
                }
                if (tx.type === "HTLC_CLAIM" && tx.htlcId === htlcId) resolvedStatus = "claimed";
                if (tx.type === "HTLC_REFUND" && tx.htlcId === htlcId) resolvedStatus = "refunded";
            }
        }
        if (!created) return null;
        return { ...created, status: resolvedStatus || "locked" };
    }
    validateHTLCClaim({ htlcId, secret, claimant }) {
        const htlc = this.findHTLC(htlcId);
        if (!htlc) return { valid: false, reason: "HTLC nie istnieje" };
        if (htlc.status !== "locked") return { valid: false, reason: `HTLC ma status "${htlc.status}", nie można odebrać` };
        if (claimant !== htlc.claimant) return { valid: false, reason: "tylko wyznaczony odbiorca może odebrać" };
        const nextHeight = this.getLatestBlock().height + 1;
        if (nextHeight >= htlc.timeoutHeight) return { valid: false, reason: "termin już minął, odbiór niemożliwy - tylko zwrot" };
        if (sha256Hex(secret) !== htlc.hashLock) return { valid: false, reason: "zły sekret - hash się nie zgadza" };
        return { valid: true, amount: htlc.amount, to: htlc.claimant };
    }
    validateHTLCRefund({ htlcId, refundee }) {
        const htlc = this.findHTLC(htlcId);
        if (!htlc) return { valid: false, reason: "HTLC nie istnieje" };
        if (htlc.status !== "locked") return { valid: false, reason: `HTLC ma status "${htlc.status}", nie można zwrócić` };
        if (refundee !== htlc.refundee) return { valid: false, reason: "tylko oryginalny nadawca może dostać zwrot" };
        const nextHeight = this.getLatestBlock().height + 1;
        if (nextHeight < htlc.timeoutHeight) return { valid: false, reason: `termin jeszcze nie minął (blok ${nextHeight} < ${htlc.timeoutHeight})` };
        return { valid: true, amount: htlc.amount, to: htlc.refundee };
    }
    getBalance(address) {
        let balance = 0;
        for (const block of this.chain) {
            const feeActive = isProjectFeeActive(block.height);
            for (const tx of block.transactions) {
                if (tx.type === "transfer" && tx.to === address) {
                    balance += feeActive ? tx.amount * (1 - PROJECT_FEE_PERCENT) : tx.amount;
                } else if (tx.type === "transfer" && tx.from === address) {
                    balance -= (tx.amount + (tx.fee || 0));
                } else if (tx.type === "HTLC_CREATE" && tx.from === address) {
                    balance -= (tx.amount + (tx.fee || 0));
                } else if (tx.type === "HTLC_CLAIM" && tx.to === address) {
                    balance += tx.amount;
                } else if (tx.type === "HTLC_REFUND" && tx.to === address) {
                    balance += tx.amount;
                } else if (tx.to === address && tx.type !== "HTLC_CREATE") {
                    // Ta sama poprawka co w getAddressStats - HTLC_CREATE ma
                    // teraz "to" (=claimant) dla samego zapisu do bazy, ale
                    // środki są zablokowane, nie odebrane - to wykluczenie
                    // zapobiega przedwczesnemu doliczeniu ich do salda.
                    balance += tx.amount;
                }
            }
        }
        return balance;
    }
    getSoloMiners() {
        const seen = new Map();
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "coinbase" && tx.to !== CONFIG.POOL_ADDRESS) {
                    const existing = seen.get(tx.to) || { address: tx.to, totalEarned: 0, blocksFound: 0, lastBlockHeight: 0 };
                    existing.totalEarned += tx.amount;
                    existing.blocksFound += 1;
                    existing.lastBlockHeight = Math.max(existing.lastBlockHeight, block.height);
                    seen.set(tx.to, existing);
                }
            }
        }
        return Array.from(seen.values()).sort((a, b) => b.lastBlockHeight - a.lastBlockHeight);
    }
    getAddressStats(whaleLimit = 10, newestLimit = 10) {
        const balances = new Map();
        const firstSeen = new Map();
        for (const block of this.chain) {
            const feeActive = isProjectFeeActive(block.height);
            for (const tx of block.transactions) {
                if (tx.type === "transfer" && tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    const credited = feeActive ? tx.amount * (1 - PROJECT_FEE_PERCENT) : tx.amount;
                    balances.set(tx.to, (balances.get(tx.to) || 0) + credited);
                } else if (tx.type === "HTLC_CLAIM" && tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                } else if (tx.type === "HTLC_REFUND" && tx.to) {
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                } else if (tx.to && tx.type !== "HTLC_CREATE") {
                    // HTLC_CREATE MA teraz pole "to" (=claimant, dodane żeby
                    // zapis do bazy działał - patrz buildBlockTransactions),
                    // ale środki są ZABLOKOWANE, nie odebrane - to jawne
                    // wykluczenie zapobiega przedwczesnemu doliczeniu ich do
                    // salda claimanta zanim faktycznie odbierze (HTLC_CLAIM).
                    if (!firstSeen.has(tx.to)) firstSeen.set(tx.to, block.height);
                    balances.set(tx.to, (balances.get(tx.to) || 0) + tx.amount);
                }
                if (tx.type === "transfer" && tx.from) {
                    if (!firstSeen.has(tx.from)) firstSeen.set(tx.from, block.height);
                    balances.set(tx.from, (balances.get(tx.from) || 0) - (tx.amount + (tx.fee || 0)));
                } else if (tx.type === "HTLC_CREATE" && tx.from) {
                    if (!firstSeen.has(tx.from)) firstSeen.set(tx.from, block.height);
                    balances.set(tx.from, (balances.get(tx.from) || 0) - (tx.amount + (tx.fee || 0)));
                }
            }
        }
        const addresses = Array.from(balances.keys());
        const whales = addresses
            .map((address) => ({ address, balance: balances.get(address) }))
            .sort((a, b) => b.balance - a.balance)
            .slice(0, whaleLimit);
        const newest = addresses
            .map((address) => ({ address, firstSeenHeight: firstSeen.get(address) }))
            .sort((a, b) => b.firstSeenHeight - a.firstSeenHeight)
            .slice(0, newestLimit);
        return { totalAddresses: addresses.length, whales, newest };
    }
    saveCredit(credit) {
        this.storage.saveCredit(credit);
    }
    getTransactionsForAddress(address) {
        const results = [];
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.to === address || tx.from === address) {
                    results.push({ ...tx, blockHeight: block.height });
                }
            }
        }
        return results.reverse();
    }
    getInfo() {
        const latest = this.getLatestBlock();
        const height = latest.height;
        let circulatingSupply = 0;
        for (const block of this.chain) {
            for (const tx of block.transactions) {
                if (tx.type === "coinbase" || tx.type === "genesis") circulatingSupply += tx.amount;
            }
        }
        return {
            network: CONFIG.NETWORK_NAME, symbol: CONFIG.SYMBOL, version: CONFIG.VERSION,
            chainId: CONFIG.CHAIN_ID, height, latestHash: latest.hash,
            difficulty: Math.round(this.difficulty),
            difficultyLeadingZerosApprox: Math.floor(Math.log(this.difficulty) / Math.log(16)),
            totalBlocks: this.chain.length, currentBlockReward: this.getRewardForHeight(height + 1),
            circulatingSupply, maxSupply: CONFIG.MAX_SUPPLY, premine: CONFIG.PREMINE,
            blocksUntilHalving: CONFIG.HALVING_INTERVAL - (height % CONFIG.HALVING_INTERVAL),
            blocksUntilRetarget: CONFIG.DIFFICULTY_ADJUSTMENT - (height % CONFIG.DIFFICULTY_ADJUSTMENT),
            legacySnapshot: this.storage.getMeta("legacySnapshot", false),
            legacyCheckpointHeight: this.storage.getMeta("legacyCheckpointHeight", null),
            legacyMissingHeights: this.storage.getMeta("legacyMissingHeights", 0),
            legacyHashMismatches: this.storage.getMeta("legacyHashMismatches", 0),
            legacySourcePeer: this.storage.getMeta("legacySourcePeer", null),
            isValid: true
        };
    }
    close() { this.storage.close(); }
}
module.exports = Blockchain;
module.exports.difficultyToTargetHex = difficultyToTargetHex;
module.exports.computeBlockHash = computeBlockHash;
module.exports.sha256Hex = sha256Hex;
