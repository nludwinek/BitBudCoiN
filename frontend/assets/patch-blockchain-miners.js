const fs = require("fs");
let content = fs.readFileSync("bbcblockchain.js", "utf8");
const CONFIG_CHECK = fs.readFileSync("config.js", "utf8");

const anchor = `    getChain() { return this.chain; }`;
const addition = `
    getSoloMiners() {
        const CONFIG = require("./config");
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
    }`;

if (!content.includes(anchor)) {
    console.log("❌ Nie znalazłem punktu zaczepienia - nic nie zmieniłem. Wklej mi swój aktualny bbcblockchain.js.");
    process.exit(1);
}
content = content.replace(anchor, anchor + addition);
fs.writeFileSync("bbcblockchain.js", content);
console.log("✅ bbcblockchain.js zaktualizowany poprawnie.");
