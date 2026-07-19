// Uruchom na serwerze: node diagnose-chain.js
// Przechodzi przez CAŁY prawdziwy łańcuch, blok po bloku, tym samym kodem
// co prawdziwa walidacja - i mówi dokładnie, na którym bloku i dlaczego
// coś nie pasuje, zamiast tylko "łańcuch niepoprawny".
const CONFIG = require("./config");
const Storage = require("./storage");
const crypto = require("crypto");

const MAX_TARGET = (1n << 256n) - 1n;
function difficultyToTargetHex(difficulty) {
    const safe = BigInt(Math.max(1, Math.round(difficulty)));
    return (MAX_TARGET / safe).toString(16).padStart(64, "0");
}
function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
    return crypto.createHash("sha256")
        .update(height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce)
        .digest("hex");
}

const storage = new Storage(CONFIG.DATABASE);
const records = storage.loadChain();

console.log(`Łańcuch ma ${records.length} bloków (wysokość 0 do ${records.length - 1}).\n`);

const genesis = records[0];
if (genesis.height !== 0 || genesis.previousHash !== "0".repeat(64)) {
    console.log("❌ GENESIS: nieprawidłowa wysokość albo previousHash");
} else if (computeBlockHash(genesis) !== genesis.hash) {
    console.log("❌ GENESIS: przeliczony hash nie zgadza się z zapisanym");
    console.log("   zapisany:  ", genesis.hash);
    console.log("   przeliczony:", computeBlockHash(genesis));
} else {
    console.log("✅ Genesis OK");
}

let firstProblem = null;
for (let i = 1; i < records.length; i++) {
    const b = records[i], prev = records[i - 1];
    const recomputed = computeBlockHash(b);

    if (recomputed !== b.hash) {
        firstProblem = { height: b.height, reason: "przeliczony hash NIE zgadza się z zapisanym", detail: `zapisany: ${b.hash}\n   przeliczony: ${recomputed}` };
        break;
    }
    if (b.hash > difficultyToTargetHex(b.difficulty)) {
        firstProblem = { height: b.height, reason: "hash NIE spełnia wymaganej trudności", detail: `hash: ${b.hash}\n   cel: ${difficultyToTargetHex(b.difficulty)}` };
        break;
    }
    if (b.previousHash !== prev.hash) {
        firstProblem = { height: b.height, reason: "previousHash NIE zgadza się z hashem poprzedniego bloku", detail: `b.previousHash: ${b.previousHash}\n   prev.hash:     ${prev.hash}` };
        break;
    }
    if (b.height !== prev.height + 1) {
        firstProblem = { height: b.height, reason: "wysokość nie jest kolejna", detail: `to: ${b.height}, poprzednie: ${prev.height}` };
        break;
    }
    if (b.timestamp < prev.timestamp) {
        firstProblem = { height: b.height, reason: "znacznik czasu MNIEJSZY niż poprzedniego bloku", detail: `ten blok: ${new Date(b.timestamp).toISOString()} (${b.timestamp})\n   poprzedni: ${new Date(prev.timestamp).toISOString()} (${prev.timestamp})` };
        break;
    }
}

if (firstProblem) {
    console.log(`\n❌ ZNALEZIONO PROBLEM na bloku #${firstProblem.height}:`);
    console.log(`   Powód: ${firstProblem.reason}`);
    console.log(`   ${firstProblem.detail}`);
} else {
    console.log("\n✅ Cały łańcuch przeszedł walidację bez zarzutu, blok po bloku.");
}

storage.close();
