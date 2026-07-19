// Fraza odzyskiwania BitBudCoin - 12 prostych słów zamiast surowego klucza.
// 12 słów z listy 256 = 96 bitów entropii (astronomicznie bezpieczne).
// Ta sama fraza ZAWSZE odtwarza dokładnie ten sam portfel - deterministycznie.

function seedBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function generateSeedPhrase() {
    const indices = new Uint8Array(12);
    crypto.getRandomValues(indices);
    // Uint8Array daje 0-255, lista ma dokładnie 256 słów - idealne dopasowanie
    return Array.from(indices).map((i) => SEED_WORDLIST[i]);
}

function seedPhraseToEntropy(words) {
    if (words.length !== 12) throw new Error("Fraza musi mieć dokładnie 12 słów");
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
        const idx = SEED_WORDLIST.indexOf(words[i].toLowerCase().trim());
        if (idx === -1) throw new Error(`Słowo "${words[i]}" nie jest na liście - sprawdź pisownię`);
        bytes[i] = idx;
    }
    return bytes;
}

async function deriveKeyPairFromSeedPhrase(words) {
    const entropy = seedPhraseToEntropy(words);
    // Rozciągnięcie 12 bajtów entropii do pełnych 32 bajtów klucza Ed25519,
    // z etykietą domeny żeby uniknąć jakiejkolwiek przypadkowej kolizji z innym zastosowaniem.
    const domainLabel = new TextEncoder().encode("BitBudCoin-seed-v1:");
    const combined = new Uint8Array(domainLabel.length + entropy.length);
    combined.set(domainLabel);
    combined.set(entropy, domainLabel.length);
    const seed32 = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));

    // Standardowy, stały nagłówek PKCS8 dla Ed25519 - zmienia się tylko ostatnie 32 bajty (sam klucz)
    const pkcs8Prefix = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
    const pkcs8Bytes = new Uint8Array(pkcs8Prefix.length + seed32.length);
    pkcs8Bytes.set(pkcs8Prefix);
    pkcs8Bytes.set(seed32, pkcs8Prefix.length);

    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8Bytes, { name: "Ed25519" }, true, ["sign"]);
    const publicKeyRaw = await crypto.subtle.exportKey("jwk", privateKey).then(async (jwk) => {
        const pubJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x, key_ops: ["verify"], ext: true };
        return crypto.subtle.importKey("jwk", pubJwk, { name: "Ed25519" }, true, ["verify"]);
    });

    const publicKeyPem = await crypto.subtle.exportKey("spki", publicKeyRaw).then((buf) =>
        `-----BEGIN PUBLIC KEY-----\n${seedBufferToBase64(buf)}\n-----END PUBLIC KEY-----`
    );
    const privateKeyPem = await crypto.subtle.exportKey("pkcs8", privateKey).then((buf) =>
        `-----BEGIN PRIVATE KEY-----\n${seedBufferToBase64(buf)}\n-----END PRIVATE KEY-----`
    );

    return { privateKey, publicKeyPem, privateKeyPem };
}
