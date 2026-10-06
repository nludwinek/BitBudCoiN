"use strict";

const express = require("express");
const cors = require("cors");

const CONFIG = require("./config");
const Blockchain = require("./bbcblockchain");
const Mempool = require("./mempool");
const Pool = require("./pool");
const P2P = require("./p2p");
const SoloTracker = require("./solo-tracker");

const {
    rateLimiter,
    strictLimiter
} = require("./rate-limit");

const {
    difficultyToTargetHex,
    computeBlockHash
} = require("./bbcblockchain");

const crypto = require("crypto");   // potrzebne przez sekretPoprawny()
const bridgeTags = require("./bridge-tags");
const swapOffers = require("./swap-offers");
const { FamilyChat } = require("./family-chat");

const {
    verifyAcceptOfferSignature,
    verifyRejectOfferSignature
} = require("./swap-offers-auth");

const {
    verifyHtlcCreateSignature,
    verifyHtlcClaimSignature,
    verifyHtlcRefundSignature
} = require("./htlc-wallet");


/*
 * NAPRAWA (dzisiaj): 821 wierszy w pool_credits mialo jako
 * "minerAddress" smieci ("AbC", "test", sklejony status urzadzenia,
 * a raz nawet fraze 12 slow portfela) - zaden z punktow przyjmowania
 * minerAddress ponizej nie sprawdzal formatu. payout.js juz mial ten
 * regex i dzieki temu nigdy nic z tego nie wyplacil - ten sam check
 * teraz na granicy API, zanim smiec w ogole trafi do bazy albo (w
 * /solo/work) na stale do coinbase w prawdziwym bloku.
 */
const ADDRESS_FORMAT = /^t?BbC[0-9a-fA-F]{40}$/;


/*
 * ============================================================
 * BITBUDCOIN SERVER
 * vMax FINAL
 * ============================================================
 *
 * JEDNO ŹRÓDŁO LIVE:
 *
 *   blockchain.getInfo()
 *          ↓
 *   getLiveState()
 *          ↓
 *   /info
 *   /state
 *   /events
 *
 * Wszystkie strony mogą więc korzystać z tego samego stanu.
 *
 * SSE:
 *   - natychmiastowy snapshot po połączeniu
 *   - natychmiastowe eventy po zmianach
 *   - heartbeat
 *   - retry po zerwaniu
 *   - ID eventów
 *   - brak cache
 *   - brak proxy buffering
 *
 * Blockchain pozostaje źródłem prawdy.
 * server.js nie prowadzi drugiego mechanizmu difficulty/consensus.
 */


/*
 * ============================================================
 * EXPRESS
 * ============================================================
 */

const app = express();

// NAPRAWA (dzisiaj, PILNA): Caddy stoi przed tym procesem (reverse proxy),
// ale Express nigdy nie mial "trust proxy" ustawionego. Bez tego req.ip
// pokazuje adres OD KTOREGO faktycznie przyszlo polaczenie TCP - czyli
// Caddy (loopback), TEN SAM dla kazdego uzytkownika. rate-limit.js liczy
// limity per-IP - bez tej linii to jeden wspolny koszyk na WSZYSTKICH
// naraz, nie osobny limit per-osoba. Prawdopodobnie prawdziwa przyczyna,
// dla ktorej limity trzeba bylo podnosic 31.07 "z powodu CGNAT" - zbiorczy
// ruch wszystkich uzytkownikow razem, nie jeden dzielony adres operatora.
// "loopback" = ufaj naglowkowi X-Forwarded-For TYLKO gdy polaczenie TCP
// faktycznie przyszlo z localhost (czyli od Caddy dzialajacego na tej
// samej maszynie) - nie od dowolnego zewnetrznego adresu podszywajacego
// sie pod proxy.
app.set(
    "trust proxy",
    "loopback"
);

app.disable("x-powered-by");

app.use(cors());

app.use(
    express.json({
        limit: "1mb"
    })
);

app.use(rateLimiter);


/*
 * Porownanie sekretu odporne na pomiar czasu.
 *
 * Zwykle "a !== b" konczy porownanie na pierwszym roznym znaku, wiec czas
 * odpowiedzi zdradza, ile poczatkowych znakow zgadlo sie poprawnie.
 * Atakujacy moze odgadywac sekret znak po znaku zamiast probowac
 * wszystkich kombinacji.
 *
 * Przy sekrecie 64-znakowym i limicie 1000 zadan na minute to atak
 * odlegly, ale kosztuje nas jedna funkcje, a zamyka cala klase problemu.
 */
function sekretPoprawny(podany) {

    if (typeof podany !== "string") return false;

    const a = Buffer.from(podany, "utf8");
    const b = Buffer.from(bridgeTags.ADMIN_SECRET, "utf8");

    // timingSafeEqual wymaga rownych dlugosci - sama dlugosc nie jest
    // tajemnica, wiec sprawdzamy ja osobno.
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
}


/*
 * ============================================================
 * CORE
 * ============================================================
 */

const IS_MAIN = require.main === module;

const blockchain = new Blockchain();

const mempool = new Mempool(
    blockchain,
    blockchain.storage
);

const pool = new Pool(
    blockchain,
    {
        mempool,
        poolAddress: CONFIG.POOL_ADDRESS,
        poolFee: CONFIG.POOL_FEE,
        shareDifficulty: CONFIG.SHARE_DIFFICULTY
    }
);

const p2p = new P2P(
    blockchain,
    {
        port: CONFIG.P2P_PORT,
        peers: CONFIG.PEERS,
        mempool
    }
);

const soloTracker = new SoloTracker();
const familyChat = new FamilyChat(blockchain.storage);


/*
 * ============================================================
 * P2P START
 * ============================================================
 */

if (IS_MAIN) {
    p2p.start();
}


/*
 * ============================================================
 * LIVE STATE
 * ============================================================
 *
 * Jedna funkcja używana przez:
 *
 *   /info
 *   /state
 *   /events
 *   /pool/status
 *
 * Dzięki temu frontend nie dostaje kilku różnych wersji
 * aktualnego stanu sieci.
 */

function getLiveState() {

    const info =
        blockchain.getInfo();

    const poolStatus =
        pool.getStatus();

    // NAPRAWA (dzisiaj): brakowalo tych pol, ktorych miner.html
    // realnie potrzebuje (workingOnHeight, blockDifficulty,
    // minerDifficulties) - strona musialaby robic OSOBNE zapytanie
    // do /pool/status obok /state, co byloby dokladnie tym
    // problemem "cztery zapytania zamiast jednego", ktory /state
    // mial rozwiazac. getLiveState() zasila i SSE, i /state naraz -
    // jedna poprawka, oba miejsca korzystaja.
    const workingOnHeight =
        poolStatus.workingOnHeight;

    const blockDifficulty =
        poolStatus.blockDifficulty;

    const minerDifficulties =
        poolStatus.minerDifficulties;

    const poolMiners =
        Object.entries(
            poolStatus.sharesThisRound || {}
        ).map(([address, shares]) => ({
            minerAddress: address,
            shares,
            source: "pool"
        }));

    const soloMiners =
        soloTracker
            .getActiveMiners()
            .map((m) => ({
                ...m,
                source: "solo"
            }));

    return {
        ...info,

        /*
         * Jednolity numer wysokości.
         * Nie nadpisujemy tego, co zwrócił blockchain.
         */
        height:
            Number.isFinite(Number(info.height))
                ? Number(info.height)
                : info.height,

        pool: {
            poolAddress:
                poolStatus.poolAddress,

            poolFee:
                poolStatus.poolFee,

            shareDifficulty:
                poolStatus.shareDifficulty,

            totalSharesThisRound:
                poolStatus.totalSharesThisRound,

            workingOnHeight,
            blockDifficulty,
            minerDifficulties
        },

        activeMiners: [
            ...poolMiners,
            ...soloMiners
        ],

        soloHashrate:
            soloTracker.getTotalHashrate(),

        p2p:
            p2p.getStatus(),

        updatedAt:
            Date.now()
    };
}


/*
 * ============================================================
 * SSE — LIVE BITBUDCOIN
 * ============================================================
 */

const sseClients = new Set();

let sseEventId = 0;


function sendSSE(eventName, data) {

    const id =
        ++sseEventId;

    const message =
        `id: ${id}\n` +
        `event: ${eventName}\n` +
        `data: ${JSON.stringify(data)}\n\n`;

    for (const client of sseClients) {

        const res = client.res;

        if (
            res.writableEnded ||
            res.destroyed
        ) {
            sseClients.delete(client);
            continue;
        }

        try {

            res.write(message);

        } catch (err) {

            sseClients.delete(client);

            try {
                res.end();
            } catch (_) {}
        }
    }
}


/*
 * Natychmiastowa aktualizacja wszystkich klientów.
 *
 * Wywołujemy ją po zmianach stanu.
 */

let _lastBroadcastAt = 0;
const BROADCAST_THROTTLE_MS = 5000;

function broadcastLiveState() {

    if (sseClients.size === 0) {
        return;
    }

    // NAPRAWA (dzisiaj): 14 miejsc w tym pliku wolalo to bez zadnego
    // ograniczenia czestotliwosci - w tym /solo/heartbeat, ktory kazdy
    // AKTYWNY solo miner wysyla co 15s. Przy kilku minerach naraz to
    // dawalo pelny getLiveState()+JSON.stringify()+zapis do wszystkich
    // klientow SSE wielokrotnie na minute, PRZEZ CALY CZAS ZYCIA
    // PROCESU (nie tylko przy starcie). Potwierdzone w pm2: sterta rosla
    // w trakcie dzialania (nie tylko na starcie), a czas do OOM zalezal
    // od ruchu miedzy identycznymi restartami (60s vs 117s - im wiecej
    // heartbeatow/broadcastow zdazylo przejsc, tym szybciej padalo).
    // Throttle chroni WSZYSTKICH 14 miejsc naraz, jedna zmiana. Nowy
    // blok wciaz dotrze do przegladarki najdalej po BROADCAST_THROTTLE_MS,
    // niezauwazalne dla czlowieka, a ogranicza czestotliwosc do bezpiecznej.
    const now = Date.now();

    if (now - _lastBroadcastAt < BROADCAST_THROTTLE_MS) {
        return;
    }

    _lastBroadcastAt = now;

    // NAPRAWA (dzisiaj): wolane bez ochrony w 14 miejscach w tym pliku,
    // przy KAZDYM znalezionym bloku (solo, pula, P2P). Jesli cokolwiek
    // wewnatrz (getLiveState/sendSSE) rzuci wyjatek, caly handler route'y
    // (np. /solo/submit) padal Z BLEDEM 500 - MIMO ZE blok byl juz
    // poprawnie zapisany do lancucha. Gornik widzial "Wewnetrzny blad
    // serwera" dla bloku, ktory naprawde sie udal. To poboczny efekt
    // (live-podglad dla polaczonych przegladarek) - nigdy nie powinien
    // miec mozliwosci zepsuc glownej odpowiedzi o sukcesie.
    try {
        sendSSE(
            "state",
            getLiveState()
        );
    } catch (err) {
        console.error("broadcastLiveState() zawiodlo (nie blokuje glownej operacji): " + err.message);
    }
}


/*
 * ============================================================
 * SSE ENDPOINT
 * ============================================================
 */

const MAX_SSE_CONNECTION_MS = 10 * 60 * 1000;

app.get(
    "/events",
    (req, res) => {

        res.statusCode = 200;

        res.setHeader(
            "Content-Type",
            "text/event-stream; charset=utf-8"
        );

        res.setHeader(
            "Cache-Control",
            "no-cache, no-store, must-revalidate"
        );

        res.setHeader(
            "Connection",
            "keep-alive"
        );

        /*
         * Ważne dla Nginx / reverse proxy.
         */
        res.setHeader(
            "X-Accel-Buffering",
            "no"
        );

        res.setHeader(
            "X-Content-Type-Options",
            "nosniff"
        );

        /*
         * EventSource ma automatycznie próbować
         * połączyć się ponownie po 3 sekundach.
         */
        res.write(
            "retry: 3000\n\n"
        );

        /*
         * Wysyłamy nagłówki od razu.
         */
        if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
        }

        const client = {
            res,
            connectedAt: Date.now()
        };

        sseClients.add(client);

        /*
         * Natychmiastowy snapshot.
         *
         * Nie trzeba czekać sekundy na interval.
         */
        try {

            const initialMessage =
                `id: ${++sseEventId}\n` +
                `event: state\n` +
                `data: ${JSON.stringify(getLiveState())}\n\n`;

            res.write(initialMessage);

        } catch (err) {

            sseClients.delete(client);

            try {
                res.end();
            } catch (_) {}

            return;
        }


        /*
         * HEARTBEAT
         *
         * SSE comment zaczynający się od ":" nie jest
         * przekazywany jako normalny event do EventSource,
         * ale utrzymuje połączenie aktywne.
         */
        // NAPRAWA (dzisiaj): active handles rosly (35->69) mimo throttle
        // na broadcastach - podejrzenie, ze req.on("close") czasem nie
        // odpala niezawodnie przez Caddy (proxy moze nie przekazywac
        // zamkniecia polaczenia klienta do Node'a). Zamiast zgadywac
        // dlaczego - twardy limit, niezalezny od przyczyny: po
        // MAX_SSE_CONNECTION_MS serwer SAM zamyka polaczenie.
        // EventSource w przegladarce laczy sie od nowa automatycznie
        // (native, tanie) - dla uzytkownika niewidoczne, ale serwer
        // gwarantowanie nie trzyma gniazd bez konca.
        const maxAgeTimer =
            setTimeout(() => {

                clearInterval(heartbeat);
                sseClients.delete(client);

                try {
                    if (!res.writableEnded) {
                        res.end();
                    }
                } catch (_) {}

            }, MAX_SSE_CONNECTION_MS);

        maxAgeTimer.unref?.();


        const heartbeat =
            setInterval(() => {

                if (
                    res.writableEnded ||
                    res.destroyed
                ) {

                    clearInterval(heartbeat);
                    clearTimeout(maxAgeTimer);
                    sseClients.delete(client);
                    return;
                }

                try {

                    res.write(
                        `: heartbeat ${Date.now()}\n\n`
                    );

                } catch (err) {

                    clearInterval(heartbeat);
                    clearTimeout(maxAgeTimer);
                    sseClients.delete(client);

                    try {
                        res.end();
                    } catch (_) {}
                }

            }, 15000);

        heartbeat.unref?.();


        /*
         * Ostatni event ID.
         *
         * Nie próbujemy tutaj odtwarzać historii,
         * ponieważ /events jest streamem aktualnego stanu.
         */
        req.on(
            "close",
            () => {

                clearInterval(heartbeat);
                clearTimeout(maxAgeTimer);

                sseClients.delete(client);

                try {

                    if (!res.writableEnded) {
                        res.end();
                    }

                } catch (_) {}
            }
        );
    }
);


/*
 * ============================================================
 * PERIODIC LIVE SYNC
 * ============================================================
 *
 * To jest dodatkowa warstwa bezpieczeństwa.
 *
 * Nawet jeśli jakaś zmiana została wykonana przez moduł,
 * którego nie obsłużyliśmy bezpośrednim broadcastem,
 * wszystkie podłączone strony dostaną świeży snapshot.
 *
 * 1 sekunda = maksymalnie około 1 s opóźnienia w takim przypadku.
 */

let liveSyncInterval = null;

if (IS_MAIN) {
    liveSyncInterval =
        setInterval(() => {

        if (sseClients.size === 0) {
            return;
        }

        broadcastLiveState();

    }, 1000);

    liveSyncInterval.unref?.();
}


/*
 * NAPRAWA (dzisiaj): zamiast wielu rund "sprawdz pm2 describe jeszcze
 * raz za chwile" - jeden, greppowalny wpis co 10s w logu. Jedna
 * komenda (grep MEMTREND) pokazuje caly przebieg od startu, nie
 * pojedyncze zdjecie w losowym momencie.
 */
let memTrendInterval = null;

if (IS_MAIN) {
    memTrendInterval =
        setInterval(() => {

        const m = process.memoryUsage();

        console.log(
            "MEMTREND " +
            new Date().toISOString() +
            " heapUsed=" + Math.round(m.heapUsed / 1024 / 1024) + "MB" +
            " rss=" + Math.round(m.rss / 1024 / 1024) + "MB" +
            " sseClients=" + sseClients.size
        );

    }, 10000);

    memTrendInterval.unref?.();
}


/*
 * ============================================================
 * INFO / BLOCKCHAIN
 * ============================================================
 *
 * /info zwraca TERAZ ten sam spójny snapshot co /state.
 *
 * Dzięki temu strona, która robi apiGet("/info"), nie zobaczy
 * innego stanu niż strona korzystająca z SSE.
 */

app.get(
    "/info",
    (req, res) => {

        res.json(
            getLiveState()
        );
    }
);


app.get(
    "/blocks",
    (req, res) => {

        let limit =
            Number(req.query.limit);

        if (
            !Number.isFinite(limit) ||
            limit <= 0
        ) {
            limit = 20;
        }

        limit =
            Math.min(
                Math.floor(limit),
                100
            );

        let before = null;

        if (
            req.query.before !== undefined
        ) {

            const parsed =
                Number(req.query.before);

            if (
                Number.isInteger(parsed) &&
                parsed >= 0
            ) {
                before = parsed;
            }
        }

        res.json(
            blockchain.getRecentBlocks(
                limit,
                before
            )
        );
    }
);


app.get(
    "/blocks/:height",
    (req, res) => {

        const height =
            Number(req.params.height);

        if (
            !Number.isInteger(height) ||
            height < 0
        ) {

            return res.status(400).json({
                error:
                    "Nieprawidłowa wysokość bloku"
            });
        }

        const block =
            blockchain
                .getChain()
                .find(
                    (b) =>
                        b.height === height
                );

        if (!block) {

            return res.status(404).json({
                error:
                    "Blok nie znaleziony"
            });
        }

        res.json(block);
    }
);


/*
 * ============================================================
 * BALANCE
 * ============================================================
 */

app.get(
    "/balance/:address",
    (req, res) => {

        const address =
            req.params.address;

        const confirmed =
            blockchain.getBalance(address);

        const pending =
            mempool.getPendingDelta
                ? mempool.getPendingDelta(address)
                : 0;

        res.json({

            address,

            balance:
                confirmed,

            pendingAwareBalance:
                confirmed + pending
        });
    }
);


/*
 * ============================================================
 * NORMAL TRANSACTIONS
 * ============================================================
 */

app.post(
    "/transactions/send",
    strictLimiter,
    (req, res) => {

        const result =
            mempool.addTransaction(
                req.body
            );

        if (!result.accepted) {

            return res
                .status(400)
                .json(result);
        }

        /*
         * Mempool zmienił stan.
         * Informujemy frontend natychmiast.
         */
        broadcastLiveState();

        res.json(result);
    }
);


/*
 * ============================================================
 * POOL STATUS
 * ============================================================
 */

app.get(
    "/pool/status",
    (req, res) => {

        const status =
            pool.getStatus();

        const poolMiners =
            Object.entries(
                status.sharesThisRound || {}
            ).map(([address, shares]) => ({
                minerAddress:
                    address,

                shares,

                source:
                    "pool"
            }));

        const soloMiners =
            soloTracker
                .getActiveMiners()
                .map((m) => ({
                    ...m,
                    source:
                        "solo"
                }));

        res.json({

            ...status,

            activeMiners: [
                ...poolMiners,
                ...soloMiners
            ],

            soloHashrate:
                soloTracker.getTotalHashrate()
        });
    }
);

app.get(
    "/pool/credits/:address",
    (req, res) => {

        const address =
            req.params.address;

        if (
            typeof address !== "string" ||
            !/^t?BbC[0-9a-fA-F]{40}$/.test(address)
        ) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        res.json(
            blockchain.getCredits(
                address
            )
        );
    }
);


/*
 * ============================================================
 * NETWORK MINERS
 * ============================================================
 */

app.get(
    "/network/miners",
    (req, res) => {

        const poolMiners =
            blockchain
                .storage
                .getKnownPoolMiners()
                .map((m) => ({

                    address:
                        m.minerAddress,

                    source:
                        "pool",

                    totalEarned:
                        m.totalCredits,

                    lastBlockHeight:
                        m.lastBlockHeight,

                    roundsParticipated:
                        m.roundsParticipated
                }));

        const soloMiners =
            blockchain
                .getSoloMiners()
                .map((m) => ({

                    address:
                        m.address,

                    source:
                        "solo",

                    totalEarned:
                        m.totalEarned,

                    lastBlockHeight:
                        m.lastBlockHeight,

                    blocksFound:
                        m.blocksFound
                }));

        const all = [
            ...poolMiners,
            ...soloMiners
        ].sort(
            (a, b) =>
                b.lastBlockHeight -
                a.lastBlockHeight
        );

        res.json(all);
    }
);


/*
 * ============================================================
 * NETWORK ADDRESSES
 * ============================================================
 */

app.get(
    "/network/addresses",
    (req, res) => {

        res.json(
            blockchain.getAddressStats()
        );
    }
);


app.get(
    "/stats/new-addresses",
    (req, res) => {

        let days =
            Number(req.query.days);

        if (
            !Number.isFinite(days) ||
            days <= 0
        ) {
            days = 30;
        }

        days =
            Math.min(
                Math.floor(days),
                90
            );

        res.json(
            blockchain
                .storage
                .getNewAddressesPerDay(days)
        );
    }
);


app.get(
    "/stats/active-addresses",
    (req, res) => {

        res.json(
            blockchain
                .storage
                .getActiveAddresses24h()
        );
    }
);


/*
 * ============================================================
 * PEERS
 * ============================================================
 */

app.get(
    "/peers",
    (req, res) => {

        res.json(
            p2p.getStatus()
        );
    }
);


/*
 * ============================================================
 * JEDEN SPÓJNY SNAPSHOT
 * ============================================================
 */

app.get(
    "/state",
    (req, res) => {

        res.json(
            getLiveState()
        );
    }
);


/*
 * ============================================================
 * ADMIN — PEERS CONNECT
 * ============================================================
 */

app.post(
    "/peers/connect",
    strictLimiter,
    (req, res) => {

        const {
            address,
            secret
        } = req.body || {};

        if (
            !sekretPoprawny(secret)
        ) {

            return res.status(403).json({
                error:
                    "Zły sekret"
            });
        }

        if (
            !address ||
            typeof address !== "string" ||
            !address.includes(":")
        ) {

            return res.status(400).json({
                error:
                    "Nieprawidłowy adres - oczekiwano formatu host:port"
            });
        }

        p2p.connectToPeer(address);

        broadcastLiveState();

        res.json({

            ok:
                true,

            message:
                `Próba połączenia z ${address} rozpoczęta`
        });
    }
);


/*
 * ============================================================
 * BRIDGE ANNOTATIONS
 * ============================================================
 */

app.get(
    "/bridge/annotations",
    (req, res) => {

        res.json(
            bridgeTags.getAll()
        );
    }
);


app.post(
    "/bridge/annotations",
    strictLimiter,
    (req, res) => {

        const {
            secret,
            signature,
            blockHash,
            to,
            amount,
            chain,
            note
        } = req.body || {};

        if (
            !sekretPoprawny(secret)
        ) {

            return res.status(403).json({
                error:
                    "Zły sekret"
            });
        }

        try {

            const tag =
                bridgeTags.addTag({
                    signature,
                    blockHash,
                    to,
                    amount,
                    chain,
                    note
                });

            broadcastLiveState();

            res.json({

                ok:
                    true,

                tag
            });

        } catch (err) {

            res.status(400).json({
                error:
                    err.message
            });
        }
    }
);


/*
 * ============================================================
 * SWAP OFFERS
 * ============================================================
 */

app.get(
    "/swap/offers",
    (req, res) => {

        res.json(
            swapOffers.getAll()
        );
    }
);


app.get(
    "/swap/offers/:id",
    (req, res) => {

        const offer =
            swapOffers.getOffer(
                req.params.id
            );

        if (!offer) {

            return res.status(404).json({
                error:
                    "Oferta nie znaleziona"
            });
        }

        res.json(offer);
    }
);


app.post(
    "/swap/offers",
    strictLimiter,
    (req, res) => {

        const {
            chain,
            bbcAmount,
            expectedAmount,
            timeoutHours,
            note,
            targetSellerAddress
        } = req.body || {};

        try {

            const offer =
                swapOffers.createOffer({
                    chain,
                    bbcAmount,
                    expectedAmount,
                    timeoutHours,
                    note,
                    targetSellerAddress
                });

            broadcastLiveState();

            res.json({

                ok:
                    true,

                offer
            });

        } catch (err) {

            res.status(400).json({
                error:
                    err.message
            });
        }
    }
);


app.post(
    "/swap/offers/:id/accept",
    strictLimiter,
    (req, res) => {

        const offer =
            swapOffers.getOffer(
                req.params.id
            );

        if (!offer) {

            return res.status(404).json({
                error:
                    "Oferta nie znaleziona"
            });
        }

        if (
            !verifyAcceptOfferSignature(
                req.body,
                offer.targetSellerAddress
            )
        ) {

            return res.status(403).json({
                error:
                    "Nieprawidłowy podpis - tylko właściciel adresu docelowego może zaakceptować tę ofertę"
            });
        }

        try {

            const updated =
                swapOffers.acceptOffer(
                    req.params.id,
                    {
                        sellerPubKeyHash:
                            req.body.sellerPubKeyHash,

                        sellerBbcAddress:
                            offer.targetSellerAddress
                    }
                );

            broadcastLiveState();

            res.json({

                ok:
                    true,

                offer:
                    updated
            });

        } catch (err) {

            res.status(400).json({
                error:
                    err.message
            });
        }
    }
);


app.post(
    "/swap/offers/:id/reject",
    strictLimiter,
    (req, res) => {

        const offer =
            swapOffers.getOffer(
                req.params.id
            );

        if (!offer) {

            return res.status(404).json({
                error:
                    "Oferta nie znaleziona"
            });
        }

        if (
            !verifyRejectOfferSignature(
                req.body,
                offer.targetSellerAddress
            )
        ) {

            return res.status(403).json({
                error:
                    "Nieprawidłowy podpis - tylko właściciel adresu docelowego może odrzucić tę ofertę"
            });
        }

        try {

            const updated =
                swapOffers.rejectOffer(
                    req.params.id,
                    offer.targetSellerAddress
                );

            broadcastLiveState();

            res.json({

                ok:
                    true,

                offer:
                    updated
            });

        } catch (err) {

            res.status(400).json({
                error:
                    err.message
            });
        }
    }
);


/*
 * ============================================================
 * RODZINA BBC (family chat)
 *
 * NAPRAWA (dzisiaj, PILNA): family-chat.js istniał od dawna (napisany,
 * przemyslany - wykrywanie scamow, kolejka do rewizji czlowieka, limit
 * czestotliwosci, system ostrzezen) ale NIGDY nie byl tu podlaczony.
 * Cala strona family.html byla martwa - kazde wejscie konczylo sie
 * bledem 404 na fetch do endpointow, ktorych nigdy nie bylo.
 * ============================================================
 */

app.get(
    "/family/messages",
    (req, res) => {

        let limit =
            Number(req.query.limit);

        if (
            !Number.isFinite(limit) ||
            limit <= 0
        ) {
            limit = 50;
        }

        res.json(
            familyChat.getMessages(
                Math.min(limit, 200)
            )
        );
    }
);

app.post(
    "/family/message",
    strictLimiter,
    (req, res) => {

        const result =
            familyChat.postMessage(
                req.body
            );

        if (!result.accepted) {

            return res.status(400).json({
                reason:
                    result.reason
            });
        }

        broadcastLiveState();

        res.json(result);
    }
);

// Panel moderacji - chroniony ADMIN_SECRET, ten sam wzorzec co
// /bridge/annotations. Brak dedykowanego UI - do uzycia przez curl,
// dopoki (jesli) nie powstanie prosty panel.
app.get(
    "/family/pending",
    strictLimiter,
    (req, res) => {

        if (
            !sekretPoprawny(req.query.secret)
        ) {
            return res.status(403).json({
                error: "Zły sekret"
            });
        }

        res.json(
            familyChat.getPending()
        );
    }
);

app.post(
    "/family/review",
    strictLimiter,
    (req, res) => {

        const {
            secret,
            id,
            decision
        } = req.body || {};

        if (!sekretPoprawny(secret)) {
            return res.status(403).json({
                error: "Zły sekret"
            });
        }

        const result =
            familyChat.reviewPending(
                id,
                decision
            );

        if (!result.accepted) {

            return res.status(400).json({
                error:
                    result.reason
            });
        }

        res.json(result);
    }
);


/*
 * ============================================================
 * ADDRESS TRANSACTIONS
 * ============================================================
 */

app.get(
    "/transactions/address/:address",
    (req, res) => {

        let limit =
            Number(req.query.limit);

        if (
            !Number.isFinite(limit) ||
            limit <= 0
        ) {
            limit = 50;
        }

        limit =
            Math.min(
                Math.floor(limit),
                200
            );

        res.json(
            blockchain
                .getTransactionsForAddress(
                    req.params.address,
                    limit
                )
        );
    }
);


/*
 * ============================================================
 * HTLC
 * ============================================================
 */

app.post(
    "/htlc/submit",
    strictLimiter,
    (req, res) => {

        const tx =
            req.body;

        if (
            !tx ||
            !tx.type
        ) {

            return res.status(400).json({
                error:
                    "Brak typu transakcji"
            });
        }


        /*
         * ----------------------------------------------------
         * HTLC_CREATE
         * ----------------------------------------------------
         */

        if (
            tx.type ===
            "HTLC_CREATE"
        ) {

            if (
                typeof tx.amount !== "number" ||
                !Number.isFinite(tx.amount) ||
                !(tx.amount > 0)
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowa kwota"
                });
            }

            // NAPRAWA (dzisiaj, PILNA): to samo ryzyko co przy tx.to zwyklych
            // przelewow i adresie w coinbase - jesli claimant albo refundee
            // sa smieciem, srodki zablokowane w tym HTLC nie beda mogly
            // zostac odebrane PRZEZ NIKOGO, ani sciezka sekretu ani sciezka
            // zwrotu po terminie. Calkowita, trwala strata. Ten sam regex co
            // wszedzie indziej dzisiaj.
            if (
                !ADDRESS_FORMAT.test(
                    tx.claimant
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidlowy format adresu claimant"
                });
            }

            if (
                !ADDRESS_FORMAT.test(
                    tx.refundee
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidlowy format adresu refundee"
                });
            }

            if (
                !verifyHtlcCreateSignature(
                    tx
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowy podpis - transakcja odrzucona"
                });
            }

            if (
                blockchain.findHTLC(
                    tx.htlcId
                )
            ) {

                return res.status(400).json({
                    error:
                        "HTLC o tym ID już istnieje"
                });
            }

            const fee =
                typeof tx.fee === "number" &&
                Number.isFinite(tx.fee)
                    ? tx.fee
                    : 0;

            const available =
                mempool.getPendingAwareBalance(
                    tx.from
                );

            if (
                available <
                tx.amount + fee
            ) {

                return res.status(400).json({
                    error:
                        `Niewystarczające saldo (dostępne: ${available})`
                });
            }

            const result =
                mempool.addHtlcTransaction(
                    tx
                );

            if (
                result &&
                result.accepted === false
            ) {

                return res
                    .status(400)
                    .json(result);
            }

            broadcastLiveState();

            return res.json({
                accepted:
                    true
            });
        }


        /*
         * ----------------------------------------------------
         * HTLC_CLAIM
         * ----------------------------------------------------
         */

        if (
            tx.type ===
            "HTLC_CLAIM"
        ) {

            if (
                !verifyHtlcClaimSignature(
                    tx
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowy podpis - transakcja odrzucona"
                });
            }

            const validation =
                blockchain.validateHTLCClaim({
                    htlcId:
                        tx.htlcId,

                    secret:
                        tx.secret,

                    claimant:
                        tx.claimant
                });

            if (
                !validation.valid
            ) {

                return res.status(400).json({
                    error:
                        validation.reason
                });
            }

            const result =
                mempool.addHtlcTransaction({
                    ...tx,

                    amount:
                        validation.amount,

                    to:
                        validation.to
                });

            if (
                result &&
                result.accepted === false
            ) {

                return res
                    .status(400)
                    .json(result);
            }

            broadcastLiveState();

            return res.json({
                accepted:
                    true
            });
        }


        /*
         * ----------------------------------------------------
         * HTLC_REFUND
         * ----------------------------------------------------
         */

        if (
            tx.type ===
            "HTLC_REFUND"
        ) {

            if (
                !verifyHtlcRefundSignature(
                    tx
                )
            ) {

                return res.status(400).json({
                    error:
                        "Nieprawidłowy podpis - transakcja odrzucona"
                });
            }

            const validation =
                blockchain.validateHTLCRefund({
                    htlcId:
                        tx.htlcId,

                    refundee:
                        tx.refundee
                });

            if (
                !validation.valid
            ) {

                return res.status(400).json({
                    error:
                        validation.reason
                });
            }

            const result =
                mempool.addHtlcTransaction({
                    ...tx,

                    amount:
                        validation.amount,

                    to:
                        validation.to
                });

            if (
                result &&
                result.accepted === false
            ) {

                return res
                    .status(400)
                    .json(result);
            }

            broadcastLiveState();

            return res.json({
                accepted:
                    true
            });
        }


        return res.status(400).json({
            error:
                `Nieznany typ transakcji "${tx.type}"`
        });
    }
);


app.get(
    "/htlc/:id",
    (req, res) => {

        const htlc =
            blockchain.findHTLC(
                req.params.id
            );

        if (!htlc) {

            return res.status(404).json({
                error:
                    "HTLC nie znaleziony"
            });
        }

        res.json(htlc);
    }
);


/*
 * ============================================================
 * POOL WORK
 * ============================================================
 */

app.get(
    "/pool/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        res.json(
            pool.getWork(
                minerAddress
            )
        );
    }
);


/*
 * ============================================================
 * POOL SHARE SUBMISSION
 * ============================================================
 */

app.post(
    "/pool/submit",
    (req, res) => {

        const minerAddress =
            req.body &&
            req.body.minerAddress;

        const candidate =
            req.body &&
            req.body.candidate;

        if (
            typeof minerAddress !== "string" ||
            !minerAddress
        ) {

            return res.status(400).json({
                error:
                    "Brak adresu minera"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        if (
            !candidate ||
            typeof candidate !== "object"
        ) {

            return res.status(400).json({
                error:
                    "Brak candidate"
            });
        }

        const result =
            pool.submitShare(
                minerAddress,
                candidate
            );

        if (!result.accepted) {

            return res
                .status(400)
                .json(result);
        }

        /*
         * Share zaakceptowany.
         * Live powinien zobaczyć go natychmiast.
         */
        broadcastLiveState();


        /*
         * Jeżeli share znalazł prawdziwy blok,
         * Pool powinien już przeprowadzić właściwe
         * receiveBlock() zgodnie ze swoją logiką.
         *
         * Tutaj tylko rozsyłamy zaakceptowany blok P2P.
         */

        if (
            result.blockFound &&
            result.block
        ) {

            p2p.broadcastNewBlock(
                result.block
            );

            broadcastLiveState();
        }

        res.json(result);
    }
);


/*
 * NAPRAWA (20.09.2026): "Live" hashrate solo-gorników opieral sie
 * wylacznie na samozglaszanych attempts/interval w /solo/heartbeat -
 * zero weryfikacji, kazdy mogl jednym POST-em zglosic dowolna liczbe
 * bez realnego kopania (ta sama klasa buga co falszywe 1.52 GH/s z
 * przegladarki kiedys, patrz solo-tracker.js). Solo dostaje teraz
 * wlasny, lzejszy "share" - DOKLADNIE ten sam mechanizm co juz dziala
 * w pool.js (patrz submitShare/shareTargetHex), tylko ze STALA
 * trudnoscia zamiast adaptacyjnej personalDifficulty - solo nie
 * potrzebuje precyzji proporcjonalnej wyplaty (payout idzie wylacznie
 * przez realny /solo/submit), tylko uczciwego pomiaru do wyswietlenia.
 *
 * WAZNE: to NIE jest parametr konsensusu - nie wchodzi do bloku, nie
 * jest propagowany P2P. Nie musi byc identyczny na wszystkich wezlach
 * (w odroznieniu od config.js/GENESIS_ADDRESS/DIFFICULTY itd.).
 */
const SOLO_SHARE_DIFFICULTY_DIVISOR = 200;

function getSoloShareDifficulty() {
    return Math.max(
        1,
        Math.round(
            blockchain.difficulty / SOLO_SHARE_DIFFICULTY_DIVISOR
        )
    );
}


/*
 * ============================================================
 * SOLO WORK
 * ============================================================
 */

app.get(
    "/solo/work",
    (req, res) => {

        const minerAddress =
            req.query.minerAddress;

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        const latest =
            blockchain.getLatestBlock();

        const pendingTxs =
            mempool.selectForBlock();

        const difficulty =
            blockchain.difficulty;

        // NAPRAWA (dzisiaj, PILNA): "Do not know how to serialize a
        // BigInt" na produkcji, tuz po aktywacji ASERT (wysokosc 100k).
        // Przeczytalem difficulty, blockTarget, buildBlockTransactions()
        // w zrodle - kazde z nich POWINNO zwracac Number/string, nie
        // BigInt. Nie znalazlem jednoznacznie ktore konkretnie pole i w
        // jakich warunkach wycieka - zamiast dalej zgadywac, jawna,
        // bezpieczna konwersja tutaj, na granicy odpowiedzi. Dziala
        // niezaleznie od dokladnego mechanizmu wewnatrz.
        const safeDifficulty =
            typeof difficulty === "bigint"
                ? Number(difficulty)
                : difficulty;

        let safeBlockTarget;

        try {

            safeBlockTarget =
                difficultyToTargetHex(
                    safeDifficulty
                );

            if (
                typeof safeBlockTarget !==
                "string"
            ) {

                safeBlockTarget =
                    String(
                        safeBlockTarget
                    );
            }

        } catch (err) {

            console.error(
                "difficultyToTargetHex() zawiodlo w /solo/work: " +
                err.message
            );

            safeBlockTarget = null;
        }

        // Lzejszy prog "share" - patrz komentarz przy
        // SOLO_SHARE_DIFFICULTY_DIVISOR powyzej. Ten sam bezpieczny
        // wzorzec konwersji co safeBlockTarget powyzej.
        const soloShareDifficulty =
            getSoloShareDifficulty();

        let safeShareTarget;

        try {

            safeShareTarget =
                difficultyToTargetHex(
                    soloShareDifficulty
                );

        } catch (err) {

            console.error(
                "difficultyToTargetHex() zawiodlo dla share w /solo/work: " +
                err.message
            );

            safeShareTarget = null;
        }

        res.json({

            height:
                latest.height + 1,

            previousHash:
                latest.hash,

            timestamp:
                Date.now(),

            transactions:
                blockchain.buildBlockTransactions(
                    minerAddress,
                    pendingTxs
                ),

            difficulty:
                safeDifficulty,

            blockTarget:
                safeBlockTarget,

            shareDifficulty:
                soloShareDifficulty,

            shareTarget:
                safeShareTarget
        });
    }
);


/*
 * ============================================================
 * SOLO BLOCK SUBMISSION
 * ============================================================
 */

app.post(
    "/solo/submit",
    (req, res) => {

        const {
            candidate
        } = req.body || {};

        if (
            !candidate ||
            typeof candidate !== "object"
        ) {

            return res.status(400).json({
                error:
                    "Brak candidate"
            });
        }

        const result =
            blockchain.receiveBlock(
                candidate
            );

        if (
            !result.accepted
        ) {

            return res
                .status(400)
                .json(result);
        }

        mempool.pruneConfirmed(
            result.block
        );

        p2p.broadcastNewBlock(
            result.block
        );

        /*
         * Blok wszedł do chaina.
         * Live dostaje go natychmiast.
         */
        broadcastLiveState();

        res.json({

            status:
                "mined",

            blockHeight:
                result.block.height,

            hash:
                result.block.hash,

            reward:
                result.block
                    .transactions[0]
                    .amount
        });
    }
);


/*
 * ============================================================
 * SOLO SHARE
 *
 * Realny, zweryfikowany dowod pracy dla "Live" hashrate solo-gorników
 * - patrz solo-tracker.js i NAPRAWA (20.09.2026) przy
 * SOLO_SHARE_DIFFICULTY_DIVISOR powyzej. Zastepuje stary,
 * niczym-niezweryfikowany /solo/heartbeat jako zrodlo hashrate.
 * ============================================================
 */

app.post(
    "/solo/share",
    strictLimiter,
    (req, res) => {

        const {
            minerAddress,
            candidate
        } = req.body || {};

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        if (
            !candidate ||
            typeof candidate !== "object" ||
            typeof candidate.hash !== "string" ||
            typeof candidate.nonce === "undefined"
        ) {

            return res.status(400).json({
                error:
                    "Brak lub niepoprawny candidate"
            });
        }

        // Przeliczamy hash NIEZALEZNIE od tego co przyslal klient -
        // dokladnie ta sama funkcja co w receiveBlock() dla prawdziwych
        // blokow. Klient nie moze zaklamac hasha bez zaklamania nonce,
        // a zaklamany nonce da INNY hash niz ten zgloszony.
        const recomputedHash =
            computeBlockHash(candidate);

        if (recomputedHash !== candidate.hash) {

            return res.status(400).json({
                error:
                    "hash nie zgadza sie z nonce"
            });
        }

        // Trudnosc share'a liczona TERAZ, przez serwer - NIGDY z tego
        // co deklarowalby klient. Klient nie ma zadnego pola do
        // zaklamania trudnosci wlasnego share'a: gdyby zadeklarowal
        // wyzsza trudnosc niz realnie osiagnieta, jego prawdziwy hash
        // nie spelnilby tak twardego targetu i odpadlby ponizej; gdyby
        // zadeklarowal nizsza, wniosloby to mniej do wzoru na hashrate
        // - nie ma tu zadnej korzysci z klamstwa w zadna strone.
        const shareDifficulty =
            getSoloShareDifficulty();

        const shareTargetHex =
            difficultyToTargetHex(
                shareDifficulty
            );

        if (recomputedHash > shareTargetHex) {

            return res.status(400).json({
                error:
                    "nie spelnia trudnosci share"
            });
        }

        soloTracker.recordShare(
            minerAddress,
            shareDifficulty
        );

        res.json({
            ok:
                true
        });
    }
);


/*
 * ============================================================
 * SOLO HEARTBEAT
 * ============================================================
 */

app.post(
    "/solo/heartbeat",
    strictLimiter,
    (req, res) => {

        // NAPRAWA (20.09.2026): attempts/intervalSeconds z body NIE SA
        // JUZ CZYTANE - to byly one samozglaszane, bez zadnej
        // weryfikacji (patrz NAPRAWA przy SOLO_SHARE_DIFFICULTY_DIVISOR
        // powyzej). Endpoint zostaje wylacznie jako "widziany ostatnio"
        // dla starszych zakladek przegladarki jeszcze bez nowego kodu -
        // touch() nigdy nie wplywa na wyswietlany hashrate, tylko
        // /solo/share (realnie zweryfikowany) to robi.
        const {
            minerAddress
        } = req.body || {};

        if (!minerAddress) {

            return res.status(400).json({
                error:
                    "Brak adresu"
            });
        }

        if (!ADDRESS_FORMAT.test(minerAddress)) {

            return res.status(400).json({
                error:
                    "Nieprawidlowy format adresu"
            });
        }

        soloTracker.touch(
            minerAddress
        );

        /*
         * Status obecnosci mogl sie zmienic.
         */
        broadcastLiveState();

        res.json({
            ok:
                true
        });
    }
);


/*
 * ============================================================
 * LEGACY MINE START
 * ============================================================
 */

app.post(
    "/mine/start",
    strictLimiter,
    (req, res) => {

        res.status(410).json({
            error:
                "Solo mining wyłączone przy tej trudności - użyj kopania przez pulę lub /solo/work (miner.html)"
        });
    }
);


/*
 * ============================================================
 * MINER MODELS
 * ============================================================
 */

app.get(
    "/miners/models",
    (req, res) => {

        res.json([]);
    }
);


/*
 * ============================================================
 * 404
 * ============================================================
 */

app.use(
    (req, res) => {

        res.status(404).json({
            error:
                "Nieznany endpoint"
        });
    }
);


/*
 * ============================================================
 * GLOBAL ERROR HANDLER
 * ============================================================
 */

app.use(
    (err, req, res, next) => {

        console.error(
            "Nieobsłużony błąd:",
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            error:
                "Wewnętrzny błąd serwera"
        });
    }
);


/*
 * ============================================================
 * API START
 * ============================================================
 */

let server = null;

if (IS_MAIN) {
    server =
        app.listen(
        CONFIG.API_PORT,
        "127.0.0.1",
        () => {

            console.log(
                `BitBudCoin API nasłuchuje na porcie ${CONFIG.API_PORT}`
            );

            console.log(
                `P2P: ${CONFIG.P2P_PORT}`
            );

            console.log(
                `Sieć: ${CONFIG.NETWORK_NAME}`
            );

            console.log(
                `Symbol: ${CONFIG.SYMBOL}`
            );

            console.log(
                `ASERT activation: ${CONFIG.ASERT_ACTIVATION_HEIGHT}`
            );

            console.log(
                `ASERT halflife: ${CONFIG.ASERT_HALFLIFE_SECONDS}s`
            );

            console.log(
                `SSE: /events`
            );
        }
    );


/*
 * ============================================================
 * HTTP / SSE TIMEOUTS
 * ============================================================
 *
 * SSE jest połączeniem długotrwałym.
 *
 * Nie chcemy, żeby Node zamykał stream zanim klient
 * zdąży dostać kolejne heartbeat/eventy.
 */

server.requestTimeout = 0;

server.timeout = 0;

server.keepAliveTimeout =
    300000;

server.headersTimeout =
    305000;


}

/*
 * ============================================================
 * SOCKET KEEPALIVE
 * ============================================================
 */

if (server) {
    server.on(
        "connection",
    (socket) => {

        try {

            socket.setKeepAlive(
                true,
                10000
            );

        } catch (err) {

            console.warn(
                "Nie można ustawić TCP keepalive:",
                err.message
            );
        }
    }
);


}

/*
 * ============================================================
 * GRACEFUL SHUTDOWN
 * ============================================================
 */

let shuttingDown = false;


function shutdown(signal) {

    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `Otrzymano ${signal} - zamykanie BitBudCoin...`
    );


    /*
     * Stop Live sync.
     */
    clearInterval(
        liveSyncInterval
    );


    /*
     * Zamknij wszystkie SSE.
     */
    for (const client of sseClients) {

        try {

            client.res.end();

        } catch (err) {}
    }

    sseClients.clear();


    /*
     * P2P.
     */
    try {

        p2p.close();

    } catch (err) {

        console.error(
            "Błąd zamykania P2P:",
            err.message
        );
    }


    /*
     * Blockchain.
     */
    try {

        blockchain.close();

    } catch (err) {

        console.error(
            "Błąd zamykania blockchain:",
            err.message
        );
    }


    /*
     * HTTP server.
     */
    server.close(
        () => {

            console.log(
                "BitBudCoin API zamknięte."
            );

            process.exit(0);
        }
    );


    /*
     * Awaryjne zamknięcie.
     */
    setTimeout(
        () => {

            console.error(
                "Wymuszone zamknięcie serwera."
            );

            process.exit(1);

        },
        10000
    ).unref();
}


if (IS_MAIN) {
    process.on(
        "SIGINT",
        () => shutdown("SIGINT")
    );

    process.on(
        "SIGTERM",
        () => shutdown("SIGTERM")
    );
}


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
    app,
    server,
    blockchain,
    mempool,
    pool,
    p2p,
    getLiveState,
    broadcastLiveState
};