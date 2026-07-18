// Generowanie portfela BitBudCoin w przeglądarce (Web Crypto API, Ed25519).
// Klucz prywatny NIGDY nie jest wysyłany nigdzie przez sieć - cała ta logika
// działa lokalnie, w pamięci karty przeglądarki.
//
// Format zgodny 1:1 z backend/wallet.js (node wallet.js):
//   adres = "BbC" + pierwsze 40 znaków hex( SHA256( klucz publiczny w SPKI/DER ) )
//   eksport kluczy: PEM (PKCS8 dla prywatnego, SPKI dla publicznego)
// Dzięki temu portfel wygenerowany tutaj działa bez zmian z send.js / payout.js.

const BBC_ADDRESS_PREFIX = "BbC";

function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

// RFC 7468 - standardowe zawijanie base64 co 64 znaki
function derToPem(derBuffer, label) {
    const b64 = bufferToBase64(derBuffer);
    const lines = b64.match(/.{1,64}/g) || [b64];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function pemToDer(pem) {
    const b64 = pem
        .replace(/-----BEGIN [^-]+-----/, "")
        .replace(/-----END [^-]+-----/, "")
        .replace(/\s+/g, "");
    return base64ToBuffer(b64);
}

async function deriveAddressFromSpkiDer(spkiDerBuffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", spkiDerBuffer);
    const hex = bufferToHex(hashBuffer);
    return BBC_ADDRESS_PREFIX + hex.slice(0, 40);
}

// Generuje zupełnie nowy portfel: {address, publicKeyPem, privateKeyPem}
async function generateWallet() {
    const keyPair = await crypto.subtle.generateKey(
        { name: "Ed25519", namedCurve: "Ed25519" },
        true,
        ["sign", "verify"]
    );

    const spkiDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const pkcs8Der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);

    const address = await deriveAddressFromSpkiDer(spkiDer);
    const publicKeyPem = derToPem(spkiDer, "PUBLIC KEY");
    const privateKeyPem = derToPem(pkcs8Der, "PRIVATE KEY");

    return { address, publicKeyPem, privateKeyPem };
}

// Poniższe dwie funkcje nie są używane na tej stronie, ale są tu gotowe pod
// przyszłą stronę do wysyłania transakcji bezpośrednio z przeglądarki -
// dokładnie ten sam mechanizm podpisu co backend/wallet.js.
async function importPrivateKeyFromPem(pem) {
    const der = pemToDer(pem);
    return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

async function signPayload(privateKey, payloadObject) {
    const payloadString = JSON.stringify(payloadObject);
    const data = new TextEncoder().encode(payloadString);
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data);
    return bufferToBase64(signature);
}

// Rozpoznaje w dowolnym wklejonym tekście bloki PEM klucza prywatnego i/lub
// publicznego, niezależnie od kolejności - żeby użytkownik mógł wkleić oba
// naraz w jedno pole (np. treść dwóch pobranych plików połączoną razem).
function parseWalletBundle(text) {
    const pubMatch = text.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/);
    const privMatch = text.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
    return {
        publicKeyPem: pubMatch ? pubMatch[0] + "\n" : null,
        privateKeyPem: privMatch ? privMatch[0] + "\n" : null
    };
}

async function deriveAddressFromPublicKeyPem(publicKeyPem) {
    const der = pemToDer(publicKeyPem);
    return deriveAddressFromSpkiDer(der);
}

function downloadWalletBundle(address, publicKeyPem, privateKeyPem) {
    const content = `${publicKeyPem}\n${privateKeyPem}`;
    downloadTextFile(address + "-wallet-bundle.pem", content);
}


function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
