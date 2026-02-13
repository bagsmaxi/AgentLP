import dotenv from 'dotenv';
dotenv.config();

export const config = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
    keypairPath: process.env.WALLET_KEYPAIR_PATH || '',
  },

  server: {
    port: parseInt(process.env.PORT || '3001', 10),
    wsPort: parseInt(process.env.WS_PORT || '3002', 10),
  },

  monitoring: {
    intervalMs: parseInt(process.env.MONITOR_INTERVAL_MS || '120000', 10), // 2 min
    feeClaimThresholdSol: parseFloat(process.env.FEE_CLAIM_THRESHOLD_SOL || '0.01'),
    rebalanceEnabled: process.env.REBALANCE_CHECK_ENABLED !== 'false',
  },

  poolFilters: {
    minVolume24h: parseFloat(process.env.MIN_VOLUME_24H || '10000'),
    minLiquidity: parseFloat(process.env.MIN_LIQUIDITY || '50000'),
  },

  meteora: {
    apiBase: 'https://dlmm-api.meteora.ag',
    pairAllEndpoint: 'https://dlmm-api.meteora.ag/pair/all',
  },

  // Well-known Solana token mints
  tokens: {
    SOL_MINT: 'So11111111111111111111111111111111111111112',
    WSOL_MINT: 'So11111111111111111111111111111111111111112',
  },

  // OpenClaw AI agent integration
  openclaw: {
    enabled: process.env.OPENCLAW_ENABLED !== 'false',
    timeout: parseInt(process.env.OPENCLAW_TIMEOUT || '15000', 10), // 15s max
    cacheDurationMs: parseInt(process.env.OPENCLAW_CACHE_MS || '120000', 10), // 2 min cache
  },

  // Fee configuration
  fees: {
    treasuryWallet: process.env.TREASURY_WALLET || 'GrXgQb2KviNMzTxonV6zTwfMy61a3Ww7ZAJB82b4NAp',
    depositFeeUsd: parseFloat(process.env.DEPOSIT_FEE_USD || '0.50'), // $0.50 per deposit
    performanceFeePercent: parseFloat(process.env.PERFORMANCE_FEE_PERCENT || '10'), // 10% of earned fees
  },
} as const;
