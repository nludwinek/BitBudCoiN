// ======================================================
// BitBudCoin Core
// database.js
// ======================================================

const Database = require("better-sqlite3");
const CONFIG = require("./config");

const db = new Database(CONFIG.DATABASE);

// ------------------------------------------------------
// BLOCKS
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS blocks (

    height INTEGER PRIMARY KEY,
    hash TEXT UNIQUE,
    previousHash TEXT,
    timestamp INTEGER,
    nonce INTEGER,
    difficulty INTEGER,
    miner TEXT,
    reward REAL

)
`).run();

// ------------------------------------------------------
// TRANSACTIONS
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS transactions (

    txid TEXT PRIMARY KEY,
    blockHeight INTEGER,

    sender TEXT,
    receiver TEXT,

    amount REAL,
    fee REAL,

    signature TEXT,

    timestamp INTEGER

)
`).run();

// ------------------------------------------------------
// WALLETS
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS wallets (

    address TEXT PRIMARY KEY,

    publicKey TEXT UNIQUE,

    created INTEGER

)
`).run();

// ------------------------------------------------------
// BALANCES
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS balances (

    address TEXT PRIMARY KEY,

    balance REAL

)
`).run();

// ------------------------------------------------------
// PEERS
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS peers (

    url TEXT PRIMARY KEY,

    lastSeen INTEGER

)
`).run();

// ------------------------------------------------------
// POOL SHARES
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS pool_shares (

    id INTEGER PRIMARY KEY AUTOINCREMENT,

    miner TEXT,

    difficulty INTEGER,

    timestamp INTEGER

)
`).run();

// ------------------------------------------------------
// SETTINGS
// ------------------------------------------------------

db.prepare(`
CREATE TABLE IF NOT EXISTS settings (

    key TEXT PRIMARY KEY,

    value TEXT

)
`).run();

module.exports = db;