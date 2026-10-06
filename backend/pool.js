const CONFIG = require("./config");
const crypto = require("crypto");
const { computeBlockHash, difficultyToTargetHex } = require("./bbcblockchain");

const MAX_SEEN_SHARE_HASHES = 20000;

// Server-issued immutable mining jobs.
// A submitted share is always checked against the difficulty/targets
// that were issued with that exact job.
const WORK_JOB_TTL_MS = 2 * 60 * 1000;
const MAX_ACTIVE_WORK_JOBS = 10000;

/* Limit sledzonych trudnosci gornikow - patrz komentarz przy
   getMinerDifficulty(). 5000 to z gora wiecej, niz ta siec kiedykolwiek
   miala aktywnych gornikow (rekord historyczny: 21 adresow). */
const MAX_TRACKED_MINER_DIFFICULTIES = 5000;
const MINER_DIFFICULTY_TTL_MS = 24 * 60 * 60 * 1000;
const VARDIFF_TARGET_SECONDS = 12;
const VARDIFF_MAX_STEP = 4;
const VARDIFF_MIN_DIFFICULTY = 16;

// NAPRAWA (dzisiaj, decyzja o strategii długu wypłat): osobista trudność
// górnika mogła być capowana aż do 100% trudności sieci - przy dość
// szybkim/mocnym sprzęcie VARDIFF ratchetuje ją tam legalnie (patrz
// _adjustMinerDifficulty), a wtedy effectiveMinerDiff/blockchain.difficulty
// zbliża się do 1 i KAŻDY share jest wart blisko pełnego maxShareValue -
// mimo że to wciąż tylko share, nie blok (blockTargetHex sprawdzany osobno,
// niżej). Realne dane: dwa adresy w ten sposób wygenerowały >150000 BbC
// kredytów w ciągu kilku godzin. Sufit 25% nie zmienia szans na realny blok
// (ten check liczy się zawsze względem candidate.difficulty, niezależnie od
// tej stałej) - ogranicza tylko górny pułap POJEDYNCZEGO kredytu.
const MAX_MINER_DIFFICULTY_RATIO = 0.25;

class MiningPool {
    constructor(blockchain, { poolAddress, poolFee, shareDifficulty, mempool } = {}) {
        this.blockchain = blockchain;
        this.mempool = mempool ?? null;
        this.poolAddress = poolAddress ?? CONFIG.POOL_ADDRESS;
        this.poolFee = poolFee ?? CONFIG.POOL_FEE;
        this.shareDifficulty = Math.pow(16, shareDifficulty ?? CONFIG.SHARE_DIFFICULTY);
        this.roundShares = new Map();
        this.seenShareHashes = new Set();
        this.minerDifficulty = new Map();
        this.minerLastShareAt = new Map();

        // workId -> immutable server-side mining job
        this.workJobs = new Map();
    }
    getWork(minerAddress) {
        this._cleanupWorkJobs();

        const latest = this.blockchain.getLatestBlock();
        const height = latest.height + 1;
        const blockDifficulty = this.blockchain.difficulty;
        const personalDifficulty = minerAddress
            ? this.getMinerDifficulty(minerAddress)
            : this.shareDifficulty;

        const pendingTxs = this.mempool ? this.mempool.selectForBlock() : [];
        const transactions = this.blockchain.buildBlockTransactions(this.poolAddress, pendingTxs);

        const timestamp = Date.now();
        const shareTarget = difficultyToTargetHex(personalDifficulty);
        const blockTarget = difficultyToTargetHex(blockDifficulty);
        const workId = crypto.randomBytes(16).toString("hex");

        const job = Object.freeze({
            workId,
            minerAddress: minerAddress ?? null,
            height,
            previousHash: latest.hash,
            timestamp,

            // Keep an immutable serialized copy for exact template validation.
            transactionsJson: JSON.stringify(transactions),

            blockDifficulty,
            personalDifficulty,
            shareTarget,
            blockTarget,
            createdAt: Date.now()
        });

        this.workJobs.set(workId, job);
        this._enforceWorkJobLimit();

        return {
            workId,
            height,
            previousHash: latest.hash,
            timestamp,
            transactions,
            difficulty: blockDifficulty,
            shareTarget,
            blockTarget,
            requestedBy: minerAddress ?? null
        };
    }

    submitShare(minerAddress, candidate, workId) {
        if (!minerAddress) {
            return { accepted: false, code: "WRONG_MINER", reason: "Brak adresu gornika" };
        }

        if (!candidate || typeof candidate.hash !== "string") {
            return { accepted: false, code: "INVALID_JOB_DATA", reason: "Nieprawidlowe zgloszenie" };
        }

        if (typeof workId !== "string" || !/^[0-9a-f]{32}$/.test(workId)) {
            return { accepted: false, code: "UNKNOWN_JOB", reason: "Brak workId" };
        }

        const job = this.workJobs.get(workId);

        if (!job) {
            return { accepted: false, code: "UNKNOWN_JOB", reason: "Nieznany workId" };
        }

        if ((Date.now() - job.createdAt) > WORK_JOB_TTL_MS) {
            this.workJobs.delete(workId);
            return { accepted: false, code: "STALE_JOB", reason: "Job wygasl - pobierz nowa prace" };
        }

        if (job.minerAddress !== minerAddress) {
            return { accepted: false, code: "WRONG_MINER", reason: "workId nalezy do innego gornika" };
        }

        if (
            candidate.height !== job.height ||
            candidate.previousHash !== job.previousHash ||
            candidate.timestamp !== job.timestamp ||
            candidate.difficulty !== job.blockDifficulty ||
            JSON.stringify(candidate.transactions) !== job.transactionsJson
        ) {
            return {
                accepted: false,
                code: "INVALID_JOB_DATA",
                reason: "Kandydat nie odpowiada wydanemu jobowi"
            };
        }

        if (computeBlockHash(candidate) !== candidate.hash) {
            return { accepted: false, code: "INVALID_HASH", reason: "hash nie zgadza sie z trescia" };
        }

        if (this.seenShareHashes.has(candidate.hash)) {
            return { accepted: false, code: "DUPLICATE_SHARE", reason: "duplikat" };
        }
        // NAPRAWA (dzisiaj, PILNA): nic tutaj nie sprawdzalo, ze coinbase w
        // zgloszonym kandydacie faktycznie idzie na this.poolAddress, tak
        // jak wydal je getWork(). Gornik mogl wziac szablon, podmienic
        // odbiorce coinbase na WLASNY adres, wykopac to, i ukrasc cala
        // nagrode bloku - konsensus (bbcblockchain.js) akceptuje KAZDY
        // poprawny format+kwote coinbase, nie tylko adres puli (bo solo
        // miners LEGALNIE uzywaja wlasnego adresu). Kazda proba manipulacji
        // odrzucona CALKOWICIE - zero udzialu tez, nie tylko odmowa pelnego
        // bloku - inaczej oplacaloby sie probowac (najgorszy przypadek:
        // dostajesz udzial jak za uczciwe zgloszenie).
        const candidateCoinbase = Array.isArray(candidate.transactions)
            ? candidate.transactions.find((tx) => tx && tx.type === "coinbase")
            : null;
        if (!candidateCoinbase || candidateCoinbase.to !== this.poolAddress) {
            return { accepted: false, code: "INVALID_JOB_DATA", reason: "coinbase w zgloszeniu nie idzie na adres puli - odrzucone" };
        }
        /*
         * NAPRAWA: submitShare NIE sprawdzalo ani candidate.height, ani
         * candidate.previousHash.
         *
         * Gornik mogl pobrac szablon RAZ i kopac przeciw niemu bez konca.
         * Kazde zgloszenie przechodzilo (hash zgadza sie z trescia, PoW
         * spelnia jego trudnosc, coinbase idzie na pule) i liczylo sie do
         * wyplaty - mimo ze taki blok NIGDY nie zostalby przyjety, bo
         * wskazuje na nieaktualnego poprzednika.
         *
         * Skutek: taki gornik zarabia z blokow znalezionych przez
         * pozostalych. To kradziez od innych uczestnikow puli.
         *
         * Dopuszczamy szczyt lancucha ORAZ jego rodzica. Jeden blok zapasu
         * jest konieczny: gornik moze wyslac zgloszenie w tej samej chwili,
         * w ktorej ktos inny znalazl blok, i bylby ukarany za wyscig,
         * ktorego nie mogl przewidziec.
         */
        {
            const szczyt = this.blockchain.getLatestBlock();
            const rodzic = this.blockchain.chain.length > 1
                ? this.blockchain.chain[this.blockchain.chain.length - 2]
                : null;

            const dozwolone = [szczyt.hash];
            if (rodzic) dozwolone.push(rodzic.hash);

            if (
                typeof candidate.previousHash !== "string" ||
                !dozwolone.includes(candidate.previousHash)
            ) {
                return {
                    accepted: false,
                    code: "STALE_JOB",
                    reason: "zgloszenie dotyczy nieaktualnego bloku - pobierz nowa prace"
                };
            }

            const oczekiwanaWysokosc =
                candidate.previousHash === szczyt.hash
                    ? szczyt.height + 1
                    : szczyt.height;

            if (candidate.height !== oczekiwanaWysokosc) {
                return {
                    accepted: false,
                    code: "STALE_JOB",
                    reason: "wysokosc zgloszenia nie pasuje do wskazanego poprzednika"
                };
            }
        }
        // IMPORTANT: validate against THIS job, not current mutable VARDIFF.
        const shareTargetHex = job.shareTarget;

        if (candidate.hash > shareTargetHex) {
            return {
                accepted: false,
                code: "LOW_DIFFICULTY_SHARE",
                reason: "nie spelnia trudnosci share"
            };
        }

        const minerDiffAtSubmit = job.personalDifficulty;

        // Changes only the difficulty used for future jobs.
        this._adjustMinerDifficulty(minerAddress);
        this._rememberShareHash(candidate.hash);
        this.roundShares.set(minerAddress, (this.roundShares.get(minerAddress) || 0) + 1);
        let paidNow = 0;
        if (minerAddress !== this.poolAddress) {
            const height = job.height;
            const reward = this.blockchain.getRewardForHeight(height);
            const maxShareValue = reward * (1 - this.poolFee);
            // Ten sam MAX_MINER_DIFFICULTY_RATIO co w _adjustMinerDifficulty,
            // ale wymuszony TU NIEZALEŻNIE - z tych samych powodów co
            // uzasadnienie Math.min() ponizej: pojedynczy punkt poprawności
            // (tylko w ratchecie) jest kruchy, wymuszenie na wyjsciu nie jest.
            const effectiveMinerDiff = Math.min(minerDiffAtSubmit, job.blockDifficulty * MAX_MINER_DIFFICULTY_RATIO);
            const rawShareValue = maxShareValue * (effectiveMinerDiff / job.blockDifficulty);
            // NAPRAWA (2026-08-27, audyt VARDIFF): powyzsze dwa Math.min()
            // (na effectiveMinerDiff i przez konstrukcje samego stosunku)
            // matematycznie nie pozwalaja rawShareValue przekroczyc
            // maxShareValue - potwierdzone recznie, linia po linii, w tej
            // sesji. Mimo to w bazie znaleziono wiersze do 256x wyzsze niz
            // ten teoretyczny sufit (12544 zamiast max 49), z okresu
            // sprzed obecnej wersji tego pliku - dowod ze poleganie
            // WYLACZNIE na poprawnosci wzoru w gorze funkcji jest kruche:
            // jedna przyszla zmiana w ktoryms Math.min() wyzej, i sufit
            // znika bez ostrzezenia, znowu. Ten Math.min() tutaj jest
            // NIEZALEZNYM, jawnym gwarantem na WYJSCIU funkcji - nie
            // polega na tym ze reszta wzoru wyzej pozostanie poprawna
            // na zawsze, wymusza to bezposrednio na ostatecznej wartosci.
            const shareValue = Math.min(rawShareValue, maxShareValue);
            if (shareValue > 0) {
                this.blockchain.saveCredit({ minerAddress, blockHeight: height, shares: 1, amount: shareValue, timestamp: Date.now() });
                paidNow = shareValue;
            }
        }
        // NAPRAWA (dzisiaj, PILNA): byla tu ta sama choroba co w
        // receiveBlock() - "czy to juz pelny blok" sprawdzalo sie wzgledem
        // ZYWEJ this.blockchain.difficulty (Date.now() w chwili TEGO checku),
        // a nie wzgledem candidate.difficulty (to co gornik faktycznie
        // dostal i wobec czego liczyl hashe). Skutek: ta brama i
        // receiveBlock() PONIZEJ oceniali "czy to blok" wzgledem DWOCH
        // ROZNYCH celow - obiekt ktory przeszedl TUTAJ (bo zywy, spelzly cel
        // byl akurat bardziej permisywny) mogl i tak wywalic sie
        // WEWNATRZ receiveBlock(), na jego wlasnym, poprawnie juz
        // naprawionym checku PoW-wzgledem-candidate.difficulty. Log:
        // "BLOK ODRZUCONY ... nie spelnia trudnosci" mimo ze receiveBlock()
        // nie mial juz problemu z samym numerem trudnosci (naprawione
        // wczesniej) - to byla TA brama, nie on.
        //
        // Naprawa: ten sam punkt odniesienia co receiveBlock() faktycznie
        // sprawdza - candidate.difficulty, nie zywy zegar.
        const blockTargetHex = job.blockTarget;
        if (candidate.hash > blockTargetHex) return { accepted: true, share: true, blockFound: false, paidNow };
        const result = this.blockchain.receiveBlock(candidate);
        if (!result.accepted) console.error("BLOK ODRZUCONY przy wysokosci " + candidate.height + ": " + result.reason);
        if (!result.accepted) return { accepted: true, share: true, blockFound: false, note: result.reason, paidNow };
        this._finalizeRound();
        if (this.mempool) this.mempool.pruneConfirmed(result.block);
        return { accepted: true, share: true, blockFound: true, block: result.block, paidNow };
    }
    _cleanupWorkJobs(now = Date.now()) {
        for (const [workId, job] of this.workJobs) {
            if ((now - job.createdAt) > WORK_JOB_TTL_MS) {
                this.workJobs.delete(workId);
            }
        }
    }

    _enforceWorkJobLimit() {
        this._cleanupWorkJobs();

        while (this.workJobs.size > MAX_ACTIVE_WORK_JOBS) {
            const oldestWorkId = this.workJobs.keys().next().value;
            if (oldestWorkId === undefined) break;
            this.workJobs.delete(oldestWorkId);
        }
    }

    /*
     * NAPRAWA - wyciek pamieci przez samo pobieranie pracy.
     *
     * BYLO: ta funkcja TWORZYLA wpis dla kazdego adresu, o ktory zapytano.
     * Wolana jest z getWork(), czyli ze zwyklego GET /pool/work - bez
     * kopania, bez podpisu, bez zadnego kosztu dla pytajacego.
     *
     * Przy globalnym limicie 1000 zadan na minute to 1.44 mln wpisow
     * dziennie. Kazdy to klucz 43-znakowy plus wartosc - rzedu 200 MB
     * dziennie na maszynie, ktora ma 950 MB i okolo 200 MB zajete przez
     * lancuch.
     *
     * TERAZ: odczyt NIE zapisuje. Wpis powstaje dopiero przy pierwszym
     * PRAWDZIWYM zgloszeniu (_adjustMinerDifficulty), czyli po wykonaniu
     * realnej pracy. VARDIFF dziala tak samo - dla nieznanego gornika
     * pierwsza trudnosc to i tak wartosc domyslna.
     */
    getMinerDifficulty(minerAddress) {
        const zapisana = this.minerDifficulty.get(minerAddress);
        return zapisana === undefined ? this.shareDifficulty : zapisana;
    }

    /*
     * Sprzatanie gornikow, ktorzy dawno nie zglosili nic. Bez tego mapa
     * rosnie przez caly czas dzialania wezla, nawet przy uczciwym ruchu.
     */
    _sprzatnijNieaktywnych() {
        if (this.minerDifficulty.size <= MAX_TRACKED_MINER_DIFFICULTIES) return;

        const teraz = Date.now();

        for (const [adres, kiedy] of this.minerLastShareAt) {
            if (teraz - kiedy > MINER_DIFFICULTY_TTL_MS) {
                this.minerDifficulty.delete(adres);
                this.minerLastShareAt.delete(adres);
            }
        }

        // Gdyby czyszczenie po czasie nie wystarczylo (masowy naplyw
        // swiezych adresow), usuwamy najstarsze.
        if (this.minerDifficulty.size > MAX_TRACKED_MINER_DIFFICULTIES) {
            const wgCzasu = Array.from(this.minerLastShareAt.entries())
                .sort((a, b) => a[1] - b[1]);

            const doUsuniecia =
                this.minerDifficulty.size - MAX_TRACKED_MINER_DIFFICULTIES;

            for (let i = 0; i < doUsuniecia && i < wgCzasu.length; i++) {
                this.minerDifficulty.delete(wgCzasu[i][0]);
                this.minerLastShareAt.delete(wgCzasu[i][0]);
            }
        }
    }
    _adjustMinerDifficulty(minerAddress) {
        const now = Date.now();

        // Wpis powstaje TUTAJ - po zgloszeniu, ktore przeszlo walidacje
        // i wymagalo realnej pracy. Nie przy samym pytaniu o prace.
        if (!this.minerDifficulty.has(minerAddress)) {
            this.minerDifficulty.set(minerAddress, this.shareDifficulty);
            this._sprzatnijNieaktywnych();
        }
        const lastAt = this.minerLastShareAt.get(minerAddress);
        this.minerLastShareAt.set(minerAddress, now);
        if (!lastAt) return;
        const elapsedSeconds = Math.max((now - lastAt) / 1000, 0.001);
        const current = this.getMinerDifficulty(minerAddress);
        let ratio = VARDIFF_TARGET_SECONDS / elapsedSeconds;
        ratio = Math.max(1 / VARDIFF_MAX_STEP, Math.min(VARDIFF_MAX_STEP, ratio));
        const diffCeiling = this.blockchain.difficulty * MAX_MINER_DIFFICULTY_RATIO;
        const next = Math.min(diffCeiling, Math.max(VARDIFF_MIN_DIFFICULTY, current * ratio));
        this.minerDifficulty.set(minerAddress, next);
    }
    _rememberShareHash(hash) {
        // NAPRAWA (dzisiaj): pelne .clear() przy przekroczeniu limitu
        // otwieralo chwilowe okno - hash zgloszony TUZ PRZED czyszczeniem
        // mogl zostac wyslany ponownie zaraz po i zaliczony DRUGI RAZ,
        // bo ochrona przed duplikatami na moment znikala calkowicie.
        // Usuwanie tylko najstarszej polowy nie ma tego okna - najnowsze
        // (i najbardziej prawdopodobne do powtorki) hashe zawsze zostaja.
        if (this.seenShareHashes.size > MAX_SEEN_SHARE_HASHES) {
            const keepFrom = Math.floor(this.seenShareHashes.size / 2);
            const remaining = Array.from(this.seenShareHashes).slice(keepFrom);
            this.seenShareHashes = new Set(remaining);
        }
        this.seenShareHashes.add(hash);
    }
    _finalizeRound() {
        this.roundShares = new Map();
    }
    getStatus() {
        const latest = this.blockchain.getLatestBlock();
        return { poolAddress: this.poolAddress, poolFee: this.poolFee, workingOnHeight: latest.height + 1, shareDifficulty: Math.round(this.shareDifficulty), blockDifficulty: Math.round(this.blockchain.difficulty), sharesThisRound: Object.fromEntries(this.roundShares), totalSharesThisRound: Array.from(this.roundShares.values()).reduce((a, b) => a + b, 0), minerDifficulties: Object.fromEntries(Array.from(this.minerDifficulty.entries()).map(([addr, d]) => [addr, Math.round(d)])) };
    }
    getCredits(minerAddress) { return this.blockchain.getCredits(minerAddress); }
}
module.exports = MiningPool;