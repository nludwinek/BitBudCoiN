// =====================================================
// BitBudCoin Wallet (Legend Version+)
// wallet.js
// =====================================================

const crypto = require("crypto");
const EC = require("elliptic").ec;
const ec = new EC("secp256k1");

class Wallet {
    constructor(privateKey = null) {
        if (privateKey) {
            this.keyPair = ec.keyFromPrivate(privateKey, "hex");
        } else {
            this.keyPair = ec.genKeyPair();
        }

        this.privateKey = this.keyPair.getPrivate("hex");
        this.publicKey = this.keyPair.getPublic("hex");
        this.address = Wallet.publicKeyToAddress(this.publicKey);
    }

    static publicKeyToAddress(pubKeyHex) {
        const hash = crypto
            .createHash("sha256")
            .update(pubKeyHex)
            .digest("hex");

        return "BbC" + hash.slice(0, 40);
    }

    sign(data) {
        const hash = crypto
            .createHash("sha256")
            .update(JSON.stringify(data))
            .digest("hex");

        const signature = this.keyPair.sign(hash, "hex");
        return signature.toDER("hex");
    }

    static verifySignature(publicKey, data, signatureHex) {
        const key = ec.keyFromPublic(publicKey, "hex");

        const hash = crypto
            .createHash("sha256")
            .update(JSON.stringify(data))
            .digest("hex");

        return key.verify(hash, signatureHex);
    }
}

module.exports = Wallet;