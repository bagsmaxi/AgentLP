import DLMM from '@meteora-ag/dlmm';
import { ScoredPool, StrategyConfig, StrategyName } from '../types';
import { getMeteoraService } from '../services/meteora';
import { aiRecommendStrategy } from '../services/openclaw';
import { logger } from '../utils/logger';

/**
 * Volatility classification based on pool characteristics.
 *
 * High bin_step = designed for more volatile pairs (memecoin, etc.)
 * Low bin_step = designed for tighter-range pairs (stables, LSTs)
 */
type VolatilityClass = 'low' | 'medium' | 'high';

function classifyVolatility(pool: ScoredPool): VolatilityClass {
  // bin_step is in basis points: 1 = 0.01%, 100 = 1%
  // Common bin steps on Meteora:
  //   1-5: stablecoins, LSTs (low volatility)
  //   10-25: major pairs like SOL/USDC (medium)
  //   50-100+: memecoins, volatile pairs (high)
  if (pool.binStep <= 5) return 'low';
  if (pool.binStep <= 30) return 'medium';
  return 'high';
}

/**
 * Determine the base bin range width based on volatility.
 * Wider ranges = stay in range longer = more passive.
 *
 * Price range covered = binRangeWidth × binStep (in basis points)
 * Example: 30 bins × 80bp = 24% price range for volatile tokens
 */
function getBaseBinRangeWidth(volatility: VolatilityClass): number {
  switch (volatility) {
    case 'low':
      return 60;   // stables: 60 bins × ~1-5bp = 0.6-3% range
    case 'medium':
      return 40;   // major pairs: 40 bins × ~10-25bp = 4-10% range
    case 'high':
      return 30;   // volatile: 30 bins × ~50-100bp = 15-30% range
  }
}

/**
 * Apply momentum-aware widening to the bin range.
 * If a token has high recent volume momentum (trending), widen the range
 * so the position stays in range longer during directional moves.
 *
 * volumeMomentum is 0-1 where:
 *   0 = no recent activity
 *   0.4+ = rising (4h volume is 20%+ of 24h)
 *   0.7+ = hot (4h volume is 35%+ of 24h)
 */
function applyMomentumWidening(baseWidth: number, momentum: number): number {
  if (momentum >= 0.7) {
    // HOT: token is very active, widen by 40% to handle fast moves
    return Math.round(baseWidth * 1.4);
  }
  if (momentum >= 0.4) {
    // RISING: moderately active, widen by 20%
    return Math.round(baseWidth * 1.2);
  }
  return baseWidth;
}

/**
 * Select the best strategy type based on pool volatility.
 */
function selectStrategy(volatility: VolatilityClass): StrategyName {
  switch (volatility) {
    case 'low':
      return 'Spot';      // Uniform distribution - best for low vol
    case 'medium':
      return 'Curve';     // Bell curve concentration around active price
    case 'high':
      return 'BidAsk';    // Concentrated on one side - good for directional vol
  }
}

/**
 * For single-sided SOL LP, we need to place liquidity on the correct side.
 *
 * In DLMM:
 *   - Bins ABOVE the active bin hold token X
 *   - Bins BELOW the active bin hold token Y
 *
 * If SOL is tokenX:
 *   - X goes into bins ABOVE the active bin
 *   - Range: [activeBin + 1, activeBin + binRangeWidth]
 *
 * If SOL is tokenY:
 *   - Y goes into bins BELOW the active bin
 *   - Range: [activeBin - binRangeWidth, activeBin - 1]
 */
function computeSingleSidedBinRange(
  activeBinId: number,
  binRangeWidth: number,
  solSide: 'X' | 'Y'
): { minBinId: number; maxBinId: number } {
  if (solSide === 'X') {
    // SOL is tokenX - X goes ABOVE active bin
    return {
      minBinId: activeBinId + 1,
      maxBinId: activeBinId + binRangeWidth,
    };
  } else {
    // SOL is tokenY - Y goes BELOW active bin
    return {
      minBinId: activeBinId - binRangeWidth,
      maxBinId: activeBinId - 1,
    };
  }
}

/**
 * Main optimization function: given a scored pool, determine the optimal
 * strategy configuration for a single-sided SOL LP position.
 *
 * Uses momentum-aware widening to handle trending tokens better.
 */
export async function optimizeStrategy(pool: ScoredPool): Promise<StrategyConfig> {
  const meteora = getMeteoraService();

  // Load the on-chain pool to get current active bin
  const dlmmPool = await meteora.getPool(pool.address);
  const activeBin = await meteora.getActiveBin(dlmmPool);
  const activeBinId = activeBin.binId;

  // Rule-based defaults with momentum widening
  const volatility = classifyVolatility(pool);
  let strategyType = selectStrategy(volatility);
  const baseWidth = getBaseBinRangeWidth(volatility);
  const momentum = pool.volumeMomentum || 0;
  let binRangeWidth = applyMomentumWidening(baseWidth, momentum);

  // Ask OpenClaw AI for recommendation (falls back to rule-based if unavailable)
  const aiRec = await aiRecommendStrategy(pool, activeBinId);
  if (aiRec) {
    strategyType = aiRec.strategyType;
    binRangeWidth = aiRec.binRangeWidth;
    logger.info('Using OpenClaw AI strategy', {
      pool: pool.name,
      strategy: aiRec.strategyType,
      binWidth: aiRec.binRangeWidth,
      confidence: aiRec.confidence,
      reasoning: aiRec.reasoning,
    });
  }

  // Compute bin range for single-sided deposit
  const { minBinId, maxBinId } = computeSingleSidedBinRange(
    activeBinId,
    binRangeWidth,
    pool.solSide
  );

  const priceRangePercent = (binRangeWidth * pool.binStep / 100).toFixed(1);

  const strategyConfig: StrategyConfig = {
    strategyType,
    minBinId,
    maxBinId,
    binRange: maxBinId - minBinId + 1,
  };

  logger.info('Strategy optimized', {
    pool: pool.name,
    volatility,
    momentum: momentum.toFixed(2),
    strategy: strategyType,
    activeBin: activeBinId,
    range: `${minBinId} to ${maxBinId}`,
    binCount: strategyConfig.binRange,
    priceRange: `~${priceRangePercent}%`,
    aiPowered: !!aiRec,
  });

  return strategyConfig;
}

/**
 * Quick analysis: classify a pool without hitting on-chain data.
 * Includes momentum-aware bin width.
 */
export function quickClassify(pool: ScoredPool): {
  volatility: VolatilityClass;
  suggestedStrategy: StrategyName;
  suggestedBinWidth: number;
} {
  const volatility = classifyVolatility(pool);
  const baseWidth = getBaseBinRangeWidth(volatility);
  const momentum = pool.volumeMomentum || 0;
  return {
    volatility,
    suggestedStrategy: selectStrategy(volatility),
    suggestedBinWidth: applyMomentumWidening(baseWidth, momentum),
  };
}
