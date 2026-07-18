cat > config.js << 'EOF'
module.exports = {
    NETWORK_NAME: "BitBudCoin",
    SYMBOL: "BbC",
    VERSION: "1.0.0",
    CHAIN_ID: 28000000,
    MAX_SUPPLY: 28000000,
    PREMINE: 700,
    GENESIS_ADDRESS: "BbC694f9417395ed990fce2b3c3fe3d756959bf3b1e",
    GENESIS_TRANSACTIONS: [
        { to: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7", amount: 700 }
    ],
    BLOCK_TIME: 480,
    BLOCK_REWARD: 50,
    DIFFICULTY: 7,
    DIFFICULTY_ADJUSTMENT: 2028,
    HALVING_INTERVAL: 210000,
    POOL_ADDRESS: "BbCcbcfc6f043ddb1f5ac83dd59feab439e192a1fb7",
    POOL_FEE: 0.02,
    SHARE_DIFFICULTY: 2,
    DATABASE: process.env.DATABASE_PATH || "bbc.db",
    API_PORT: process.env.PORT || 5000,
    P2P_PORT: 6001,
    PEERS: [],
    MIN_FEE: 0.001,
    MAX_BLOCK_SIZE: 1000000,
    MAX_TRANSACTIONS_PER_BLOCK: 5000
};
EOF