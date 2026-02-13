import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

// ── Pool Data (from Meteora DLMM API) ──

export interface MeteoraTimeBreakdown {
  min_30: number;
  hour_1: number;
  hour_2: number;
  hour_4: number;
  hour_12: number;
  hour_24: number;
}

export interface MeteoraPairData {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  reserve_x: string;
  reserve_y: string;
  reserve_x_amount: number;
  reserve_y_amount: number;
  bin_step: number;
  base_fee_percentage: string;
  max_fee_percentage: string;
  protocol_fee_percentage: string;
  liquidity: string;
  reward_mint_x: string;
  reward_mint_y: string;
  fees_24h: number;
  today_fees: number;
  trade_volume_24h: number;
  cumulative_trade_volume: string;
  cumulative_fee_volume: string;
  current_price: number;
  apr: number;
  apy: number;
  farm_apr: number;
  farm_apy: number;
  hide: boolean;
  volume?: MeteoraTimeBreakdown;
  fees?: MeteoraTimeBreakdown;
  fee_tvl_ratio?: MeteoraTimeBreakdown;
}

// ── Scored Pool ──

export interface ScoredPool {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  binStep: number;
  currentPrice: number;
  volume24h: number;
  volume4h: number;
  volume1h: number;
  fees24h: number;
  fees4h: number;
  feeApr: number;
  liquidity: number;
  score: number;
  solSide: 'X' | 'Y';
  isFresh?: boolean;
  volumeMomentum: number; // ratio of recent vs 24h volume (higher = more active now)
}

// ── Strategy Types ──

export type StrategyName = 'Spot' | 'Curve' | 'BidAsk';

export interface StrategyConfig {
  strategyType: StrategyName;
  minBinId: number;
  maxBinId: number;
  binRange: number; // total bins used
}

// ── Agent Session ──

export type AgentMode = 'assisted' | 'degen';
export type SessionStatus = 'running' | 'paused' | 'stopped';
export type PositionStatus = 'active' | 'closed' | 'rebalancing';

export interface StartSessionRequest {
  walletAddress: string;
  mode: AgentMode;
  solAmount: number;
  keypairPath?: string; // optional: for auto-sign mode
  tokenMint?: string; // optional: for assisted mode — user-specified token CA
}

export interface CreatePositionRequest {
  walletAddress: string;
  poolAddress: string;
  solAmount: number;
  keypairPath?: string;
}

// ── Position Info ──

export interface PositionInfo {
  id: string;
  walletAddress: string;
  poolAddress: string;
  poolName: string;
  positionPubkey: string;
  mode: AgentMode;
  solDeposited: number;
  strategy: StrategyName;
  minBinId: number;
  maxBinId: number;
  status: PositionStatus;
  createdAt: Date;
  totalFeesEarned: number;
  totalRewardsEarned: number;
  rebalanceCount: number;
  currentActiveBin?: number;
  isInRange?: boolean;
}

// ── Scoring Weights ──

export interface ScoringWeights {
  volumeWeight: number;
  feesWeight: number;
  aprWeight: number;
  liquidityWeight: number;
  binStepWeight: number;
  historyWeight: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  volumeWeight: 0.25,
  feesWeight: 0.30,
  aprWeight: 0.20,
  liquidityWeight: 0.10,
  binStepWeight: 0.05,
  historyWeight: 0.10,
};

// DEGEN mode: chase highest APR, accept riskier pools
export const DEGEN_SCORING_WEIGHTS: ScoringWeights = {
  volumeWeight: 0.15,
  feesWeight: 0.10,
  aprWeight: 0.40,
  liquidityWeight: 0.10,
  binStepWeight: 0.05,
  historyWeight: 0.20,
};

export const DEGEN_FILTER_OVERRIDES = {
  minVolume24h: 5000,
  minLiquidity: 5000,
};

// ── API Response Types ──

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ── Transaction Preparation Result ──

export interface PreparedTransaction {
  serializedTx: string; // base64 encoded for wallet adapter signing
  positionPubkey: string;
  poolAddress: string;
  strategy: StrategyConfig;
  blockhash?: string;
  lastValidBlockHeight?: number;
}
