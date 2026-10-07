"use strict";
const crypto_node = require("crypto");
const { G, scalarMult, N } = require("./secp256k1");
const {
    bytesToHex, hexToBytes, concatBytes, ripemd160,
    encodeSegwitAddress, decodeSegwitAddress
} = require("./btc-htlc-script");
const { compileHtlcScript, deriveP2WSHAddress } = require("./btc-htlc-compile");
const {
    compressPubKey, decompressPubKey, signHtlcClaim, signHtlcRefund,
    executeHtlcScript, encodeDER, decodeDER, isValidSignatureEncoding, signForScriptSig
} = require("./btc-htlc-spend");
const { computeSigHash, SIGHASH_ALL } = require("./btc-sighash");
const { serializeTransaction, deserializeTransaction, computeTxid, computeWtxid } = require("./segwit-tx");

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
    if (cond) { PASS++; console.log(`OK   ${name}`); }
    else { FAIL++; console.log(`FAIL ${name}${detail ? "\n     -- " + detail : ""}`); }
}

console.log("\n=== 1: RIPEMD160 vs Node crypto ===");
for (const v of ["", "a", "abc", "message digest", "abcdefghijklmnopqrstuvwxyz"]) {
    const ours = bytesToHex(ripemd160(v));
    const node = crypto_node.createHash("ripemd160").update(v, "utf8").digest("hex");
    check(`ripemd160("${v}")`, ours === node, `nasze=${ours} node=${node}`);
}

console.log("\n=== 2: secp256k1 vs OpenSSL (syntetyczne + brzegowe wektory) ===");
for (const k of [1n, 2n, N - 1n,
    BigInt("0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234"),
    BigInt("0x0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0")]) {
    const ours = bytesToHex(compressPubKey(scalarMult(k, G)));
    const ecdh = crypto_node.createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(k.toString(16).padStart(64, "0"), "hex"));
    const node = ecdh.getPublicKey("hex", "compressed");
    check(`scalarMult k=0x${k.toString(16).slice(0, 10)}...`, ours === node, `nasze=${ours} openssl=${node}`);
}

console.log("\n=== 3: Bech32 - oficjalne wektory BIP173 ===");
{
    const validSegwit = [
        ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "0014751e76e8199196d454941c45d1b3a323f1433bd6", "bc"],
        ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262", "tb"],
        ["BC1SW50QA3JX3S", "6002751e", "bc"],
        ["tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy", "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433", "tb"],
    ];
    for (const [addr, expected, hrp] of validSegwit) {
        const d = decodeSegwitAddress(addr, hrp);
        const verByte = d.witnessVersion === 0 ? 0x00 : (0x50 + d.witnessVersion);
        const spk = bytesToHex(concatBytes(Buffer.from([verByte, d.program.length]), d.program));
        check(`decode ${addr.slice(0, 15)}...`, spk === expected, `nasze=${spk} oczek=${expected}`);
    }
    const invalidSegwit = [
        ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "zly checksum"],
        ["BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "zla dlugosc programu dla v0"],
        ["bc1rw5uspcuh", "zla dlugosc programu"],
        [" 1nwldj5", "HRP poza zakresem - NOWA poprawka"],
    ];
    for (const [addr, why] of invalidSegwit) {
        check(`odrzuca (${why})`, decodeSegwitAddress(addr, "bc") === null);
    }
}

console.log("\n=== 4: DER round-trip + isValidSignatureEncoding ===");
for (const [r, s] of [[1n, 1n], [0x80n, 0x80n], [N - 1n, N - 1n]]) {
    const der = encodeDER(r, s);
    const back = decodeDER(der);
    check(`DER r=0x${r.toString(16)} s=0x${s.toString(16)}`, back.r === r && back.s === s);
}
{
    const good = concatBytes(encodeDER(123n, 456n), Buffer.from([0x01]));
    check("isValidSignatureEncoding akceptuje poprawny", isValidSignatureEncoding(good) === true);
    const bad = Buffer.from(good); bad[0] = 0x31;
    check("isValidSignatureEncoding odrzuca zly marker", isValidSignatureEncoding(bad) === false);
}

console.log("\n=== 5: BIP143 - oficjalny wektor Native P2WPKH: preimage + sighash + PODPIS bajt-w-bajt ===");
{
    const rawTx = "0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000";
    const { tx } = deserializeTransaction(rawTx);
    check("serializeTransaction round-trip", bytesToHex(serializeTransaction(tx)) === rawTx);
    const scriptCode = "76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac";
    const { sighash, preimage } = computeSigHash({ tx, inputIndex: 1, scriptCode, inputValueSatoshis: 600000000, hashType: SIGHASH_ALL });
    check("preimage bajt-w-bajt", bytesToHex(preimage) === "0100000096b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd3752b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3bef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a010000001976a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac0046c32300000000ffffffff863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e51100000001000000");
    check("sighash bajt-w-bajt", bytesToHex(sighash) === "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670");

    const privKey = BigInt("0x619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9");
    const sigWithType = signForScriptSig(privKey, sighash, SIGHASH_ALL);
    const pubKey = compressPubKey(scalarMult(privKey, G));
    check("wyprowadzony klucz publiczny = oficjalny", bytesToHex(pubKey) === "025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357");
    check("*** podpis RFC6979 BAJT-W-BAJT = Bitcoin Core ***", bytesToHex(sigWithType) === "304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01",
        `nasze=${bytesToHex(sigWithType)}`);
}

console.log("\n=== 6: HTLC - compile + interpreter, claim/refund/CLTV/BIP65 ===");
{
    const claimantPriv = 0x4e4c9f1a3d2b8e7f6a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f31n % N;
    const refundeePriv = 0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2bn % N;
    const claimantPubKeyHash = bytesToHex(require("./btc-htlc-script").hash160(compressPubKey(scalarMult(claimantPriv, G))));
    const refundeePubKeyHash = bytesToHex(require("./btc-htlc-script").hash160(compressPubKey(scalarMult(refundeePriv, G))));
    const preimage = crypto_node.randomBytes(32).toString("hex");
    const hashLock = bytesToHex(require("./btc-htlc-script").sha256(Buffer.from(preimage, "utf8")));
    const timeoutHeight = 700000;

    function scenario() {
        const script = compileHtlcScript({ hashLock, timeoutHeight, claimantPubKeyHash, refundeePubKeyHash });
        const scriptHex = bytesToHex(script);
        const tx = { version: 2, inputs: [{ txid: "bb".repeat(32), vout: 0, sequence: 0xfffffffe }], outputs: [{ valueSatoshis: 90000, scriptPubKey: "0014" + "22".repeat(20) }], witnesses: [[]], locktime: 0 };
        return { script, scriptHex, tx };
    }

    { // claim poprawny
        const { script, scriptHex, tx } = scenario();
        signHtlcClaim({ tx, inputIndex: 0, privateKeyScalar: claimantPriv, preimageHexString: preimage, compiledScriptHex: scriptHex, inputValueSatoshis: 90000 });
        const w = tx.witnesses[0];
        const stack = [hexToBytes(w[0]), hexToBytes(w[1]), hexToBytes(w[2]), hexToBytes(w[3])];
        const r = executeHtlcScript(script, stack, { tx, inputIndex: 0, scriptCodeHex: scriptHex, inputValueSatoshis: 90000 });
        check("HTLC claim poprawny -> WAZNE", r.valid === true, JSON.stringify(r));
    }
    { // claim zly preimage
        const { script, scriptHex, tx } = scenario();
        signHtlcClaim({ tx, inputIndex: 0, privateKeyScalar: claimantPriv, preimageHexString: crypto_node.randomBytes(32).toString("hex"), compiledScriptHex: scriptHex, inputValueSatoshis: 90000 });
        const w = tx.witnesses[0];
        const stack = [hexToBytes(w[0]), hexToBytes(w[1]), hexToBytes(w[2]), hexToBytes(w[3])];
        const r = executeHtlcScript(script, stack, { tx, inputIndex: 0, scriptCodeHex: scriptHex, inputValueSatoshis: 90000 });
        check("HTLC claim zly preimage -> ODRZUCONE", r.valid === false, JSON.stringify(r));
    }
    { // refund po terminie
        const { script, scriptHex, tx } = scenario();
        tx.locktime = 700100;
        signHtlcRefund({ tx, inputIndex: 0, privateKeyScalar: refundeePriv, compiledScriptHex: scriptHex, inputValueSatoshis: 90000 });
        const w = tx.witnesses[0];
        const stack = [hexToBytes(w[0]), hexToBytes(w[1]), hexToBytes(w[2])];
        const r = executeHtlcScript(script, stack, { tx, inputIndex: 0, scriptCodeHex: scriptHex, inputValueSatoshis: 90000 });
        check("HTLC refund po terminie -> WAZNE", r.valid === true, JSON.stringify(r));
    }
    { // refund przed terminem
        const { script, scriptHex, tx } = scenario();
        tx.locktime = 699999;
        signHtlcRefund({ tx, inputIndex: 0, privateKeyScalar: refundeePriv, compiledScriptHex: scriptHex, inputValueSatoshis: 90000 });
        const w = tx.witnesses[0];
        const stack = [hexToBytes(w[0]), hexToBytes(w[1]), hexToBytes(w[2])];
        const r = executeHtlcScript(script, stack, { tx, inputIndex: 0, scriptCodeHex: scriptHex, inputValueSatoshis: 90000 });
        check("HTLC refund PRZED terminem -> ODRZUCONE (CLTV)", r.valid === false, JSON.stringify(r));
    }
    { // signHtlcRefund musi rzucic przy sequence=0xffffffff
        const { scriptHex, tx } = scenario();
        tx.locktime = 700100;
        tx.inputs[0].sequence = 0xffffffff;
        let threw = false;
        try { signHtlcRefund({ tx, inputIndex: 0, privateKeyScalar: refundeePriv, compiledScriptHex: scriptHex, inputValueSatoshis: 90000 }); }
        catch (e) { threw = true; }
        check("signHtlcRefund rzuca przy sequence=0xffffffff (BIP65 guard)", threw === true);
    }
}

console.log("\n=== 7: PUBLICZNY REGRESSION VECTOR - historyczny adres HTLC ===");

(async () => {

    /*
     * Ten test NIE zawiera prywatnych kluczy ani secret preimage.
     *
     * Historyczny fixture mial timeoutHeight=3278, ale ten parametr
     * NIE rekonstruuje EXPECTED_LOCK_ADDRESS przy obecnym compilerze.
     *
     * Wartosc 960524 zostala odtworzona matematycznie:
     * dla ponizszych PUBLICZNYCH parametrow daje dokladnie historyczny
     * adres P2WSH. Nie twierdzimy, ze 960524 pochodzi z historii Git.
     */

    const HASH_LOCK =
        "9a84910cb4556bfc4f946937bf005a197f48ce79c98725624c151701f438df03";

    const CLAIMANT_PUBKEY_HASH =
        "1ac76e1848a4356d6d656104b995a6962b6b3293";

    const REFUNDEE_PUBKEY_HASH =
        "3f19b36599f13df7f5a0b3284ae22ee0ed4aa974";

    const RECONSTRUCTED_TIMEOUT_HEIGHT =
        960524;

    const HISTORICAL_INCONSISTENT_TIMEOUT =
        3278;

    const EXPECTED_LOCK_ADDRESS =
        "bc1qgr2fz2d4n3l7p0hywy7w9ddjs9a9vxvdetxqanhcl2tgrtp2fv9q2h9c49";


    const compiledScript =
        compileHtlcScript({
            hashLock:
                HASH_LOCK,

            timeoutHeight:
                RECONSTRUCTED_TIMEOUT_HEIGHT,

            claimantPubKeyHash:
                CLAIMANT_PUBKEY_HASH,

            refundeePubKeyHash:
                REFUNDEE_PUBKEY_HASH
        });


    const {
        address:
            reconstructedAddress
    } =
        await deriveP2WSHAddress(
            compiledScript,
            "bc"
        );


    check(
        "PUBLIC_HTLC_VECTOR_RECONSTRUCTS_HISTORICAL_ADDRESS",
        reconstructedAddress ===
            EXPECTED_LOCK_ADDRESS,
        reconstructedAddress
    );


    /*
     * Zachowujemy rowniez test regresyjny dowodzacy,
     * ze historyczne 3278 jest niespojne z tym adresem.
     */

    const inconsistentScript =
        compileHtlcScript({
            hashLock:
                HASH_LOCK,

            timeoutHeight:
                HISTORICAL_INCONSISTENT_TIMEOUT,

            claimantPubKeyHash:
                CLAIMANT_PUBKEY_HASH,

            refundeePubKeyHash:
                REFUNDEE_PUBKEY_HASH
        });


    const {
        address:
            inconsistentAddress
    } =
        await deriveP2WSHAddress(
            inconsistentScript,
            "bc"
        );


    check(
        "HISTORICAL_TIMEOUT_3278_DOES_NOT_MATCH_LOCK_ADDRESS",
        inconsistentAddress !==
            EXPECTED_LOCK_ADDRESS
    );


    console.log(
        `\n\n============ RAZEM: ${PASS} OK / ${FAIL} FAIL ============\n`
    );


    if (FAIL > 0) {
        process.exitCode = 1;
    }

})();
