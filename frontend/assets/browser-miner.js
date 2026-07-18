// Kopanie w przeglądarce - działa dopóki karta jest otwarta, bez instalowania
// niczego. Liczy hashe tym samym algorytmem co backend/bbcblockchain.js,
// żeby zgłoszone shares były akceptowane, nie odrzucane.

const BrowserMiner = (() => {
    let mining = false;
    let sessionStats = { shares: 0, blocksFound: 0, attempts: 0 };
    let onUpdate = () => {};
    let onLog = () => {};

    async function computeBlockHash({ height, previousHash, timestamp, transactions, difficulty, nonce }) {
        const str = height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce;
        const bytes = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function mineOneShare(work, apiBase) {
        const candidate = {
            height: work.height,
            previousHash: work.previousHash,
            timestamp: work.timestamp,
            transactions: work.transactions,
            difficulty: work.difficulty,
            nonce: 0
        };
        let hash = await computeBlockHash(candidate);
        const maxAttempts = 300000;

        while (hash > work.shareTarget) {
            if (!mining) return null;
            candidate.nonce++;
            sessionStats.attempts++;
            if (candidate.nonce % 200 === 0) onUpdate(sessionStats);
            if (candidate.nonce >= maxAttempts) return "expired";
            hash = await computeBlockHash(candidate);
        }
        candidate.hash = hash;
        return candidate;
    }

    async function loop(minerAddress, apiBase) {
        while (mining) {
            let work;
            try {
                work = await fetch(`${apiBase}/pool/work?minerAddress=${encodeURIComponent(minerAddress)}`).then((r) => r.json());
            } catch (err) {
                onLog("⚠️ Brak połączenia z serwerem, ponawiam za 3s...", "warn");
                await new Promise((r) => setTimeout(r, 3000));
                continue;
            }

            const candidate = await mineOneShare(work, apiBase);
            if (!mining) break;
            if (candidate === "expired") continue;
            if (!candidate) continue;

            try {
                const result = await fetch(`${apiBase}/pool/submit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ minerAddress, candidate })
                }).then((r) => r.json());

                if (result.blockFound) {
                    sessionStats.blocksFound++;
                    onLog(`🎉 Blok #${result.block.height} znaleziony!`, "block");
                } else if (result.accepted) {
                    sessionStats.shares++;
                    onLog(`Share zaakceptowany (#${sessionStats.shares})`, "share");
                } else {
                    onLog(`Odrzucone: ${result.reason}`, "warn");
                }
                onUpdate(sessionStats);
            } catch (err) {
                onLog("⚠️ Błąd zgłaszania share, ponawiam...", "warn");
            }
        }
    }

    return {
        start(minerAddress, apiBase, callbacks = {}) {
            if (mining) return;
            mining = true;
            sessionStats = { shares: 0, blocksFound: 0, attempts: 0 };
            onUpdate = callbacks.onUpdate || (() => {});
            onLog = callbacks.onLog || (() => {});
            loop(minerAddress, apiBase);
        },
        stop() {
            mining = false;
        },
        isMining() {
            return mining;
        },
        getStats() {
            return sessionStats;
        }
    };
})();
