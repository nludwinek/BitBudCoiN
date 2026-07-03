// =====================================================
// BitBudCoin Core v1.0
// config.js
// =====================================================

const CONFIG = {

    // -----------------------------
    // NETWORK
    // -----------------------------
    NETWORK_NAME: "BitBudCoin",
    SYMBOL: "BbC",
    VERSION: "1.0.0",
    CHAIN_ID: 28000000,

    // -----------------------------
    // SUPPLY
    // -----------------------------
    MAX_SUPPLY: 28000000,

    PREMINE: 2000000,

    // -----------------------------
    // GENESIS
    // -----------------------------
    GENESIS_ADDRESS:
        "BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e",

    GENESIS_TRANSACTIONS: [

        {
            to: "BbC73ce5a7944bb8405b9da4529739aa5491b392ffe",
            amount: 250
        },

        {
            to: "BbC73ce5a7944bb8405b9da4529739aa5491b392ffe",
            amount: 450
        }

    ],

    // -----------------------------
    // MINING
    // -----------------------------
    BLOCK_TIME: 480,

    BLOCK_REWARD: 50,

    DIFFICULTY: 4,

    DIFFICULTY_ADJUSTMENT: 2028,

    HALVING_INTERVAL: 210000,

    // -----------------------------
    // POOL
    // -----------------------------
    POOL_FEE: 0.02,

    SHARE_DIFFICULTY: 2,

    // -----------------------------
    // DATABASE
    // -----------------------------
    DATABASE: "bbc.db",

    // -----------------------------
    // API
    // -----------------------------
    API_PORT: process.env.PORT || 5000,

    // -----------------------------
    // P2P
    // -----------------------------
    P2P_PORT: 6001,

    PEERS: [],

    // -----------------------------
    // SECURITY
    // -----------------------------
    MIN_FEE: 0.001,

    MAX_BLOCK_SIZE: 1000000,

    MAX_TRANSACTIONS_PER_BLOCK: 5000

};

module.exports = CONFIG;
