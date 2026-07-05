// Wysyła podpisaną transakcję do serwera. Klucz prywatny zostaje LOKALNIE -
// serwer widzi tylko klucz publiczny i podpis, nigdy klucz prywatny.
//
// Użycie: node send.js <ścieżka_do_pliku_z_kluczem_prywatnym> <adresOdbiorcy> <kwota> <opłata> [url_serwera]
// Plik z kluczem prywatnym to po prostu PEM zapisany z wallet.js.

const fs = require("fs");
const { deriveAddress, signTransaction } = require("./wallet");
const crypto = require("crypto");

const [, , privateKeyPath, to, amountStr, feeStr, serverUrl] = process.argv;

if (!privateKeyPath || !to || !amountStr) {
    console.error("Użycie: node send.js <plik_klucza_prywatnego.pem> <adresOdbiorcy> <kwota> [opłata] [url_serwera]");
    process.exit(1);
}

const privateKey = fs.readFileSync(privateKeyPath, "utf8");
const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
const from = deriveAddress(publicKey);

const amount = Number(amountStr);
const fee = feeStr ? Number(feeStr) : 0.01;
const url = serverUrl || "http://localhost:5000";

const tx = { from, to, amount, fee, timestamp: Date.now() };
const signature = signTransaction(tx, privateKey);
const candidate = { ...tx, publicKey, signature };

console.log(`Wysyłam ${amount} BbC z ${from} do ${to} (opłata ${fee})...`);

fetch(`${url}/transactions/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidate)
})
    .then((res) => res.json())
    .then((result) => {
        if (result.accepted) {
            console.log("✅ Przyjęto do mempoola. Podpis:", result.signature);
        } else {
            console.error("❌ Odrzucono:", result.reason);
            process.exitCode = 1;
        }
    })
    .catch((err) => {
        console.error("❌ Błąd połączenia:", err.message);
        process.exitCode = 1;
    });
