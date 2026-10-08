# BitBudCoin (BbC) — Technical Specification

**Status:** Draft v0.1 — 2026-10-02
**Basis:** reference node source (`wallet.js`, excerpts of `bbcblockchain.js`, `pool.js`, `server.js`) and the reference web wallet. Every algorithm below was reimplemented independently (Node.js and Python) and checked against the test vectors in section 9.
**Not covered:** items marked ⚠ are *not* specified yet — see section 10. Nothing here is guessed; where the node's behaviour is unknown, this document says so.

BitBudCoin is an independent proof-of-work blockchain (not EVM-compatible, not a fork of Bitcoin), built from scratch in Node.js, with an account/balance ledger and Ed25519 signatures.

---

## 1. Network parameters

| | Mainnet | Testnet |
|---|---|---|
| Name / ticker | BitBudCoiN / `BbC` | BitBudCoiN Testnet / `tBbC` |
| Chain identifier¹ | 28000000 | 28000001 |
| Address prefix | `BbC` | `tBbC` |
| API base URL | `https://141-147-98-57.sslip.io` | `https://testnet.141-147-98-57.sslip.io` |
| P2P | `141.147.98.57:6001` | — |
| Block time | ⚠ | 60 s |
| Ledger model | account / balance | account / balance |
| Consensus | Proof-of-Work, SHA-256 | same |
| Difficulty adjustment | ASERT (active from height 100000) | ASERT (active from height 10) |
| Signature scheme | Ed25519 (mandatory from height 3070) | same |

¹ An identifier for metadata and tooling only. BbC is **not** an EVM chain: it has no JSON-RPC `eth_*` interface, no `0x` addresses and no secp256k1 signatures.

**Amounts** are JSON numbers (IEEE-754 doubles), e.g. `1.5`, `0.003`. ⚠ A smallest indivisible unit is not defined in this version.

---

## 2. Keys and addresses

- Key type: **Ed25519**.
- Public key encoding: **SPKI** (DER), transported as PEM (`-----BEGIN PUBLIC KEY-----`).
- Private key encoding: **PKCS#8** (DER), transported in a PEM container; private material is intentionally omitted from this specification.
- **Address** = `prefix` + first 40 hex characters of `SHA-256( SPKI DER bytes of the public key )`.
  - `prefix` is `BbC` (mainnet) or `tBbC` (testnet).
  - The hex is lowercase on the network.
- Validation regex used by the node: `^t?BbC[0-9a-fA-F]{40}$`.
- **Normalisation:** the reference wallet may display addresses with mixed letter case (a typo-detection checksum shown in the UI). Everything sent to the network and everything signed uses the **lowercase** form (`BbC` + lowercase hex). Balances are keyed by the exact string, so `BbCABC…` and `BbCabc…` would be different accounts — always normalise before use. ⚠ The mixed-case checksum algorithm is not specified in this version; clients should simply accept and lowercase.

A raw 32-byte Ed25519 seed becomes a PKCS#8 key by prefixing the fixed bytes `302e020100300506032b657004220420`.

---

## 3. Recovery phrases (12 words)

Two phrase types exist. A wallet must accept both.

### 3.1 BIP39 (standard — use this for new wallets)

1. 12 English words from the official BIP39 list (2048 words), valid checksum (128-bit entropy).
2. `seed = PBKDF2-HMAC-SHA512(password = phrase joined by single spaces (NFKD), salt = "mnemonic" + passphrase, iterations = 2048, length = 64)`. The reference wallet uses an empty passphrase.
3. **SLIP-0010 (Ed25519, hardened-only)**:
   - master: `I = HMAC-SHA512(key = "ed25519 seed", data = seed)`; `k = I[0:32]`, `c = I[32:64]`.
   - child `i` (always hardened): `I = HMAC-SHA512(key = c, data = 0x00 || k || ser32(i | 0x80000000))`; `k = I[0:32]`, `c = I[32:64]`.
4. Path: `m/44'/28000000'/account'/0'/index'` — reference wallet uses `account = 0`, `index = 0`.
5. `k` is the Ed25519 seed of the key pair (section 2).

⚠ **28000000 is a provisional SLIP-44 coin type** — it has not been registered. Implementations must keep this path working even if a registered number is chosen later.

### 3.2 Legacy phrase (existing wallets)

1. 12 words from the 256-word list in the reference wallet (`assets/seed-wordlist.js`); each word is one byte (its index) → 12 bytes, 96 bits.
2. `seed32 = SHA-256( "BitBudCoin-seed-v1:" (ASCII) || 12 index bytes )`; `seed32` is the Ed25519 seed.
3. **Disambiguation:** if all 12 words are in the legacy list, the phrase is legacy. Otherwise, if it is a valid BIP39 phrase, it is BIP39.

---

## 4. Transactions (transfers)

```json
{
  "from": "BbC…",            // sender address
  "to": "BbC…",              // recipient address (lowercase)
  "amount": 1.5,             // number
  "fee": 0.003,              // number
  "timestamp": 1790000000000,// milliseconds since Unix epoch
  "publicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
  "signature": "<base64>"
}
```

**Signing payload** — exactly this string, UTF-8 encoded, fields in this order, no whitespace:

```
JSON.stringify({from, to, amount, fee, timestamp})
```

`signature = base64( Ed25519_sign(private key, payload bytes) )`. `publicKey`, `signature` and `type` are never part of the payload.

**Node verification** (all must hold): `publicKey` parses as an Ed25519 key; `address(publicKey) == from`; the signature verifies over the payload.

**Submit:** `POST /transactions/send` with the object above as the JSON body. Success: `200` with `{"accepted": true, …}`. Rejection: `400` with `{"accepted": false, …}` and a reason.

**Balance:** `GET /balance/:address` → `{"address", "balance", "pendingAwareBalance"}`.
**History:** `GET /transactions/address/:address` → array of transactions with at least `type`, `blockHeight`, `from`, `to`, `amount`.

**Fees:** the reference wallet suggests `low = max(0.001, 0.05% of amount)`, `fast = max(0.003, 0.15%)`, `turbo = max(0.008, 0.4%)`. These are wallet defaults, not consensus rules. ⚠ The node's minimum fee and mempool rules are not specified here.

---

## 5. HTLC (cross-chain swaps)

Three signed operations, all submitted with `POST /htlc/submit`. Each body is the payload fields plus `type`, `publicKey` (PEM) and `signature` (base64 over the payload string; `type` is not signed). Payload field order is fixed:

| `type` | Signed payload (`JSON.stringify` of, in order) |
|---|---|
| `HTLC_CREATE` | `htlcId, from, amount, fee, hashLock, timeoutHeight, claimant, refundee, timestamp` |
| `HTLC_CLAIM` | `htlcId, claimant, secret, timestamp` |
| `HTLC_REFUND` | `htlcId, refundee, timestamp` |

- `hashLock = hex( SHA-256( secret as UTF-8 text ) )`. The reference wallet's secret is 64 hex characters **treated as text, not decoded to bytes**.
- `timeoutHeight` is a block height. State: `GET /htlc/:id`.
- ⚠ Claim/refund timing rules and the BTC-side script are not specified here.

---

## 6. Blocks and proof-of-work

Block fields: `height`, `timestamp` (ms), `previousHash`, `transactions`, `difficulty`, `nonce`, `hash`.

```
hash = hex( SHA-256( UTF8( height + previousHash + timestamp + JSON.stringify(transactions) + difficulty + nonce ) ) )
```

All values are converted to text and **concatenated** (no separators); `JSON.stringify` uses the exact key order of the transaction objects.

**Target:** a 64-character lowercase hex string. A hash is valid when `hash <= target` as a plain string comparison. The node derives it as `target = hex64( floor( MAX_TARGET / max(1, round(difficulty)) ) )`. ⚠ `MAX_TARGET` is a node constant that is not reproduced here; miners should use the targets the pool provides (section 7).

**Transaction types** seen in a block: `coinbase` (block reward, `from: null`), `transfer`, `fee`, `protocol_fee`; HTLC operations have their own types. ⚠ The reward schedule and the coinbase/fee rules are not specified here.

**Reading the chain:** `GET /info` (includes the current `height`), `GET /blocks?limit=N` (newest first), `GET /blocks/:height`.

---

## 7. Pool mining protocol

**Get work:** `GET /pool/work?minerAddress=<address>`

```json
{
  "height": 107252, "previousHash": "…", "timestamp": 1790947644506,
  "transactions": [ … ], "difficulty": 3446582807,
  "shareTarget": "000007ae…", "blockTarget": "00000001…", "requestedBy": "<address>"
}
```

**Mine:** vary only `nonce`; compute `hash` (section 6). A hash with `hash <= shareTarget` is a *share*; with `hash <= blockTarget` it is a full block. Do **not** modify `transactions` (the coinbase pays the pool address; a changed coinbase is rejected).

**Submit:** `POST /pool/submit`

```json
{ "minerAddress": "<address>",
   "candidate": { "height", "previousHash", "timestamp", "transactions", "difficulty", "nonce", "hash" } }
```

The pool rejects a candidate when: the hash does not match its content; the hash was already submitted; the coinbase does not pay the pool; `previousHash` is neither the chain tip nor its parent; `height` is inconsistent with `previousHash`; or the hash does not meet the miner's share target. Success: `{"accepted": true, "share": true, "blockFound": <bool>, "paidNow": <number>}`. Rejection: HTTP `400` with `{"accepted": false, "reason": "…"}`.

Rewards are credited in the pool and paid out later by the pool's payout process; `paidNow` is the amount credited for that share, not a payment.

A ready-made single-file miner is in `miner/bbc-miner.js`.

---

## 8. Other endpoints

Further REST endpoints exist (swap offers, statistics, peers, solo mining) and are **not specified in this version**. Machine-readable metadata: `sdk/bbc-chain.json`.

---

## 9. Test vectors

All values below are public test data. Private material is deliberately omitted. **Never use these keys or phrases for real funds.**
Checked with two independent implementations (Node.js and Python).

### 9.1 Key, address, transaction signature

Ed25519 seed: `<SYNTHETIC_SEED_FOR_DOCUMENTATION_ONLY>`

```
<SYNTHETIC_PRIVATE_KEY_FOR_DOCUMENTATION_ONLY>
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
-----END PUBLIC KEY-----
```

SPKI DER (hex): `302a300506032b657003210003a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8`
Address: `BbCa050837d85070582ccf7394b0988847cc312cb88`

Transaction to `BbC1111111111111111111111111111111111111111`, amount `1.5`, fee `0.003`, timestamp `1790000000000`.

Signing payload:
```
{"from":"BbCa050837d85070582ccf7394b0988847cc312cb88","to":"BbC1111111111111111111111111111111111111111","amount":1.5,"fee":0.003,"timestamp":1790000000000}
```
Signature (base64, Ed25519 is deterministic):
```
rhgUhbViZxZcUvvsrfkGprJTCsdrx3eVuhK8IGWPpDAil0UZRuh0pZCNYnO6lxkwIDn4GqzsRMTUjYz8xF6uCQ==
```

### 9.2 HTLC hash lock

Secret (text): `030b131b232b333b434b535b636b737b838b939ba3abb3bbc3cbd3dbe3ebf3fb`
`hashLock = 787372aea542526809c110458ac8caca7a305d1eb5a474746bb49cc9757d0129`

### 9.3 Block hash

Input string (concatenation):
```
107252000000002d8d1543f2fe07ce8e75f4efebc20b8cc5b03b9b7efdb296f4f90dec1790947644506[{"from":null,"to":"BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7","amount":50,"type":"coinbase"}]344658280712345
```
`nonce = 12345`, `hash = f6d5540168fcf6e7b77fc550d6c94139a5338be3b25a55a4583b95439ff1e893`

### 9.4 Legacy phrase

`able acid aged also area army away baby back ball band bank` → address `BbCb1a71eac23aaf1449a1ffa6b064b7870cf535683`

### 9.5 BIP39 phrase

Phrase: `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`
BIP39 seed (empty passphrase, hex):
```
5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4
```
SLIP-0010 key at `m/44'/28000000'/0'/0'/0'` (hex): `b9c0b6143a72c4b295bb10be0c8c0202f3f89897bd3d300a766b79fe575b0468`

| Path | Address |
|---|---|
| `m/44'/28000000'/0'/0'/0'` | `BbCeeb87693e022e8595674202d517b520bd586726d` |
| `m/44'/28000000'/0'/0'/1'` | `BbC0a74eca0b9a331660c48ed66a1741e2c5ab78068` |

---

## 10. Not yet specified

- Block time and reward schedule on mainnet; halving; maximum supply; fee and `protocol_fee` rules.
- `MAX_TARGET` and the exact ASERT parameters.
- Smallest amount unit and the node's amount/fee validation limits; mempool rules.
- Mixed-case address checksum algorithm.
- P2P wire protocol.
- Responses of the endpoints listed in section 8.
- An independent, public RPC (JSON-RPC) interface.
- A registered SLIP-44 coin type.

Corrections and additions are welcome: https://github.com/Radoslawq007/BitBudCoiN
