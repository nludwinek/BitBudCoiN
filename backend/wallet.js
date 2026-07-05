// Portfel BitBudCoin - klucze Ed25519 (wbudowane w Node, zero zależności).
//
// WAŻNE: to jest moduł do użytku LOKALNEGO/KLIENCKIEGO. Prywatny klucz nigdy
// nie powinien trafić na serwer - generuj go u siebie (node wallet.js) i trzymaj
// tylko lokalnie. Serwer zna i weryfikuje wyłącznie klucz PUBLICZNY i podpisy.
//
// Adres = "BbC" + pierwsze 40 znaków sha256(klucz publiczny w formacie DER).
// Transakcja jest ważna tylko jeśli: (1) dołączony klucz publiczny wyprowadza się
// do adresu "from", (2) podpis nad treścią transakcji jest poprawny dla tego klucza.

const crypto = require("crypto");

function deriveAddress(publicKeyPem) {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
    const hash = crypto.createHash("sha256").update(der).digest("hex");
    return "BbC" + hash.slice(0, 40);
}

function generateWallet() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    return {
        address: deriveAddress(publicKeyPem),
        publicKey: publicKeyPem,
        privateKey: privateKeyPem
    };
}

// Kanoniczna treść do podpisu - TYLKO pola, które faktycznie definiują "co i ile
// komu wysyłam". Zawsze ten sam kształt/kolejność u nadawcy i weryfikującego.
function signingPayload({ from, to, amount, fee, timestamp }) {
    return JSON.stringify({ from, to, amount, fee, timestamp });
}

function signTransaction({ from, to, amount, fee, timestamp }, privateKeyPem) {
    const payload = signingPayload({ from, to, amount, fee, timestamp });
    const signature = crypto.sign(null, Buffer.from(payload), privateKeyPem);
    return signature.toString("base64");
}

// Zwraca true/false - NIGDY nie rzuca wyjątku, żeby wywołujący mógł bezpiecznie
// używać tego jako prosty warunek nawet dla całkowicie śmieciowych danych wejściowych
function verifyTransactionSignature(tx) {
    try {
        if (!tx || !tx.publicKey || !tx.signature || !tx.from) return false;

        const expectedAddress = deriveAddress(tx.publicKey);
        if (expectedAddress !== tx.from) return false;

        const payload = signingPayload(tx);
        const signature = Buffer.from(tx.signature, "base64");
        return crypto.verify(null, Buffer.from(payload), tx.publicKey, signature);
    } catch (err) {
        return false;
    }
}

module.exports = { generateWallet, deriveAddress, signTransaction, verifyTransactionSignature, signingPayload };

// Uruchomione bezpośrednio (node wallet.js) - generuje nowy portfel i wypisuje go.
// Nic nie wysyła nigdzie przez sieć.
if (require.main === module) {
    const wallet = generateWallet();
    console.log("=== Nowy portfel BitBudCoin ===");
    console.log("Adres (możesz podawać wszędzie):");
    console.log("  " + wallet.address);
    console.log("\nKlucz publiczny (możesz podawać wszędzie):");
    console.log(wallet.publicKey);
    console.log("Klucz PRYWATNY (NIGDY nikomu nie pokazuj, nie wysyłaj na serwer):");
    console.log(wallet.privateKey);
    console.log("Zapisz oba klucze w bezpiecznym miejscu - bez klucza prywatnego nie da się wydać środków z tego adresu.");
}
