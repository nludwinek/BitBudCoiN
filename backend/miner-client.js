// Przykładowy/referencyjny klient górnika dla puli BitBudCoin.
// Pokazuje jak SAMEMU liczyć hashe (u siebie, nie na serwerze) i zgłaszać shares.
//
// Użycie:  node miner-client.js <adresGórnika> [url_serwera] [maxProbNaSzablon]
// Przykład: node miner-client.js BbCmoj_adres http://localhost:5000

const { computeBlockHash } = require("./bbcblockchain");

const minerAddress = process.argv[2];
const serverUrl = process.argv[3] || "http://localhost:5000";
const maxAttemptsPerTemplate = Number(process.argv[4]) || 2_000_000;

if (!minerAddress) {
    console.error("Użycie: node miner-client.js <adresGórnika> [url_serwera]");
    process.exit(1);
}

async function getWork() {
    const res = await fetch(`${serverUrl}/pool/work?minerAddress=${encodeURIComponent(minerAddress)}`);
    if (!res.ok) throw new Error(`GET /pool/work: HTTP ${res.status}`);
    return res.json();
}

async function submitShare(candidate, workId) {
    const res = await fetch(`${serverUrl}/pool/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minerAddress, workId, candidate })
    });
    const data = await res.json().catch(() => null);

    if (!res.ok) {
        if (
            res.status === 400 &&
            data &&
            typeof data === "object"
        ) {
            return data;
        }

        throw new Error(`POST /pool/submit: HTTP ${res.status}`);
    }

    return data;
}

// Realne liczenie hashy - szuka nonce, aż trafi w shareTarget (albo skończy się limit prób
// na ten szablon, wtedy pobieramy świeższy szablon zamiast kopać w nieskończoność na starym)
function mineOneShare(work) {
    const candidate = {
        height: work.height,
        previousHash: work.previousHash,
        timestamp: work.timestamp,
        transactions: work.transactions,
        difficulty: work.difficulty,
        nonce: 0
    };

    let hash = computeBlockHash(candidate);
    let attempts = 0;

    while (hash > work.shareTarget) {
        candidate.nonce++;
        attempts++;
        if (attempts >= maxAttemptsPerTemplate) return null; // szablon "wygasł" dla nas - pobierz nowy
        hash = computeBlockHash(candidate);
    }

    candidate.hash = hash;
    return candidate;
}

async function run() {
    console.log(`⛏️  Start kopania w puli jako ${minerAddress} -> ${serverUrl}`);
    let shares = 0;
    let blocksFound = 0;

    for (;;) {
        const work = await getWork();
        const candidate = mineOneShare(work);

        if (!candidate) {
            console.log(`(szablon #${work.height} wygasł bez trafienia - pobieram świeższy)`);
            continue;
        }

        const result = await submitShare(candidate, work.workId);

        if (result.blockFound) {
            blocksFound++;
            console.log(
                `🎉 BLOK #${result.block.height} ZNALEZIONY! (nonce=${candidate.nonce}) ` +
                    `łącznie bloków: ${blocksFound}`
            );
        } else if (result.accepted) {
            shares++;
            if (shares % 10 === 0) console.log(`   ...${shares} zaakceptowanych shares`);
        } else {
            console.warn(`⚠️  Share odrzucony: ${result.reason}`);
        }
    }
}

run().catch((err) => {
    console.error("❌ Klient górnika padł:", err.message);
    process.exit(1);
});
