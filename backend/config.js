"use strict";

/*
 * ============================================================
 * WYBOR SIECI
 * ============================================================
 *
 * Domyslnie MAINNET. Testnet wlacza sie zmienna srodowiskowa:
 *
 *     BBC_NETWORK=testnet node server.js
 *
 * Bez tej zmiennej zachowanie jest IDENTYCZNE jak przed ta zmiana -
 * ponizszy obiekt to niezmieniona konfiguracja mainnetu. Delegacja
 * dzieje sie zanim cokolwiek innego zostanie odczytane, wiec zaden
 * modul nie zobaczy mieszanki parametrow z dwoch sieci.
 */
if (process.env.BBC_NETWORK === "testnet") {

    module.exports = require("./config.testnet.js");

} else {

module.exports = {
    NETWORK_NAME: "BitBudCoin",

    /*
     * Prefiks adresu. Mainnet: "BbC". Testnet: "tBbC".
     * Rozdzielone, zeby adres z sieci testowej nie wygladal identycznie
     * jak prawdziwy - tak samo jak Bitcoin rozdziela bc1... i tb1...
     */
    ADDRESS_PREFIX: "BbC",
    SYMBOL: "BbC",
    VERSION: "1.0.0",

    CHAIN_ID: 28000000,

    MAX_SUPPLY: 28000000,
    PREMINE: 700,

    GENESIS_ADDRESS: "BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e",

    GENESIS_TRANSACTIONS: [
        {
            to: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
            amount: 700
        }
    ],

    /*
     * ============================================================
     * BLOCK / REWARD
     * ============================================================
     */

    BLOCK_TIME: 480,
    BLOCK_REWARD: 50,

    /*
     * Pool payout finality.
     *
     * Przy docelowych 8 min/blok:
     * 12 potwierdzen ~= 96 minut.
     */
    PAYOUT_MIN_CONFIRMATIONS: 12,

    HALVING_INTERVAL: 210000,

    /*
     * ============================================================
     * PRE-vMax DAA
     * ============================================================
     *
     * Do bloku #99999 włącznie.
     *
     * Od #100000 kontrolę przejmuje vMax ASERT.
     */

    DIFFICULTY: 7,
    DIFFICULTY_ADJUSTMENT: 2028,
    TARGET_BLOCK_TIME_MS: 480000,

    /*
     * ============================================================
     * vMax ASERT
     * ============================================================
     *
     * #99999 = ostatni blok starego DAA
     * #100000 = pierwszy blok vMax
     *
     * Anchor = #99999
     */

    ASERT_ENABLED: true,

    ASERT_MODE: "vMax",

    ASERT_ACTIVATION_HEIGHT: 100000,

    ASERT_ANCHOR_HEIGHT: 99999,

    /*
     * Docelowy czas bloku BbC:
     * 480 sekund = 8 minut
     */
    ASERT_IDEAL_BLOCK_TIME_SECONDS: 480,

    /*
     * vMax half-life:
     * 3600 sekund = 1 godzina
     */
    ASERT_HALFLIFE_SECONDS: 3600,

    /*
     * Po aktywacji vMax:
     *
     * - brak retargetIfDue()
     * - brak EDA
     * - brak ręcznego difficulty adjustment
     * - brak emergency difficulty adjustment
     *
     * Difficulty jest wyłącznie wynikiem deterministycznego ASERT.
     */

    ASERT_DISABLE_LEGACY_DAA: true,
    ASERT_DISABLE_EMERGENCY_ADJUST: true,
    ASERT_INTEGER_ONLY: true,

    /*
     * ============================================================
     * POOL
     * ============================================================
     */

    POOL_ADDRESS: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
    POOL_FEE: 0.02,
    SHARE_DIFFICULTY: 2,

    /*
     * ============================================================
     * DATABASE / NETWORK
     * ============================================================
     */

    DATABASE: process.env.DATABASE_PATH || "bbc.db",

    API_PORT: process.env.PORT || 5000,

    P2P_PORT: 6001,

    PEERS: [
        // NAPRAWA (2026-08-24): przywrocone. Wylaczone tymczasowo 23.08
        // przy podejrzeniu o crash przy sync - realna przyczyna byla
        // brakujacy prog CHAIN_SYNC_MIN_LEAD w p2p.js (naprawiony tej
        // nocy) plus BigInt/Number w ASERT-owej walidacji replaceChain()
        // (naprawiony w tej samej sesji). Realne polaczenie z peerem
        // kolegi jeszcze nie przetestowane po tych poprawkach.
        "145.241.218.97:6001"
    ],

    /*
     * ============================================================
     * TRANSACTIONS
     * ============================================================
     */

    MIN_FEE: 0.001,

    MAX_BLOCK_SIZE: 1000000,

    MAX_TRANSACTIONS_PER_BLOCK: 5000,

    /*
     * ============================================================
     * PROJECT FEE
     * ============================================================
     */

    PROJECT_FEE_ADDRESS:
        "BbCf4c7f835449ea7ffd9d4890b4c9fa2379166157c",

    PROJECT_FEE_PERCENT: 0.02,

    PROJECT_FEE_ACTIVATION_HEIGHT: 1716,

    /*
     * ============================================================
     * WERYFIKACJA PODPISOW - PROG WYSOKOSCI
     * ============================================================
     *
     * Od tej wysokosci kazdy zwykly przelew w bloku MUSI miec poprawny
     * podpis - takze w blokach przyslanych przez P2P. Ponizej progu
     * historia zostaje nietknieta.
     *
     * Dlaczego prog, a nie "od zawsze": sprawdzenie zywej bazy
     * (sprawdz-podpisy.js, 28 229 przelewow) pokazalo, ze:
     *   - 2920 przelewow z wysokosci 109-2704 NIE MA publicKey ani
     *     signature. Wszystkie pochodza z jednego adresu - adresu puli.
     *     To wyplaty puli sprzed wdrozenia podpisywania.
     *   - 1 przelew w bloku 3069 ma odbiorce "HTLC_INTERNAL" i podpis
     *     obejmujacy inny zestaw pol (stara wersja mechanizmu HTLC,
     *     ktorej nie ma juz w kodzie).
     *   - wszystkie 25 308 pozostalych maja poprawny podpis.
     *
     * Wymaganie podpisu wstecz odrzucaloby wlasna historie przy kazdej
     * resynchronizacji z peerem i zatrzymaloby siec - co byloby gorsze
     * niz luka, ktora ta zmiana zamyka.
     *
     * 3070 to pierwszy blok powyzej ostatniego problematycznego. Objete
     * kontrola jest 99.997% lancucha.
     *
     * Bitcoin postepuje tak samo przy zmianach regul: nowa regula
     * obowiazuje od ustalonej wysokosci, historii sie nie przepisuje.
     */
    SIGNATURE_ENFORCEMENT_HEIGHT: 3070,

    /*
     * ============================================================
     * MINIMALNA TRUDNOSC - PODLOGA
     * ============================================================
     *
     * !!! ZMIANA W KONSENSUSIE - NIE WDRAZAJ SAM !!!
     *
     * Ten plik wolno wgrac dopiero wtedy, gdy WSZYSCY operatorzy wezlow
     * maja te sama wartosc. Wezel z podloga odrzuci blok, ktory wezel bez
     * podlogi przyjmie - lancuchy rozjada sie dokladnie w chwili, w
     * ktorej ta ochrona mialaby zadzialac.
     *
     * Na 10.09.2026 siec ma trzy wezly: Twoj, kolegi (145.241.218.97)
     * i jeden na Oracle Cloud, ktorego operatora nie znasz. Ten trzeci
     * NIE zostanie uprzedzony - jesli nie zaktualizuje, przy spadku
     * trudnosci ponizej podlogi odpadnie od sieci.
     *
     * ------------------------------------------------------------
     * PO CO TO JEST
     *
     * ASERT obniza trudnosc, gdy bloki trwaja dluzej niz cel. Przy
     * dostatecznie dlugim przestoju spada do 1, a wtedy KAZDY hash jest
     * poprawnym blokiem - lancuch da sie przepisac laptopem.
     *
     * Policzone dla mainnetu: przy trudnosci 3 234 814 914 i okresie
     * polowicznym 3600 s wystarczy okolo 32 GODZIN bez blokow. To nie
     * jest scenariusz odlegly - siec ma jednego duzego gornika i stala
     * juz 2.5 godziny, gdy odszedl.
     *
     * Zaobserwowane na testnecie: po nocnym postoju trudnosc spadla do 1
     * i sama nie wrocila.
     *
     * ------------------------------------------------------------
     * DLACZEGO AKURAT 16^5
     *
     * 1 048 576 przy gorniku 0.17 MH/s to blok co okolo 6 sekund - siec
     * odbudowuje sie szybko, ale kopanie przestaje byc darmowe.
     *
     * Wartosc jest ~3000 razy nizsza od dzisiejszej trudnosci sieci,
     * wiec w normalnej pracy NIE zadziala ani razu i wszystkie wezly
     * beda sie zgadzac tak jak dotad. Roznica ujawnia sie wylacznie w
     * sytuacji, przed ktora ma chronic.
     */
    MIN_DIFFICULTY: 1048576,

    /*
     * ============================================================
     * WYSOKOSC AKTYWACJI PODLOGI
     * ============================================================
     *
     * Podloga zaczyna obowiazywac dopiero OD TEGO BLOKU. Ponizej niej
     * zachowanie jest identyczne jak przed zmiana.
     *
     * PO CO: siec ma wezly, ktorych operatorow nie znamy - jeden dziala
     * na Oracle Cloud i nie ma jak go uprzedzic. Bez wysokosci aktywacji
     * trzeba by sie z kazdym umowic na wdrozenie w tej samej chwili, co
     * przy otwartej sieci jest niewykonalne.
     *
     * Tak samo rozwiazuje to Bitcoin: regula wchodzi od ogloszonej
     * wysokosci, a nie od momentu, w ktorym ktos wgral plik. Kto
     * zaktualizuje przed tym blokiem - dziala dalej. Kto nie - odpadnie
     * wtedy i tylko wtedy, gdy trudnosc realnie spadnie ponizej podlogi.
     *
     * Ten sam wzorzec zastosowano juz przy SIGNATURE_ENFORCEMENT_HEIGHT.
     *
     * 105 838 to okolo 14 dni od wysokosci 103 318 (10.09.2026) przy
     * obecnym tempie ~180 blokow dziennie. Dwa tygodnie na aktualizacje
     * to zapas z gora wystarczajacy.
     */
    MIN_DIFFICULTY_ACTIVATION_HEIGHT: 105838
};

}
