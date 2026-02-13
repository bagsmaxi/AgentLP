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
 * Context from a previous position, used during rebalance to learn and adapt.
 */
export interface RebalanceContext {
  prevMinBinId: number;
  prevMaxBinId: number;
  prevCreatedAt: Date;
  prevActiveBinId?: number; // active bin when previous position was created (approx)
  rebalanceCount: number;
}

/**
 * Apply rebalance-aware widening based on how the previous position performed.
 *
 * If the position went out of range quickly, the price is moving fast in one direction.
 * We widen the range proportionally to how fast it went out of range.
 */
function applyRebalanceWidening(
  baseWidth: number,
  ctx: RebalanceContext,
  currentActiveBinId: number,
): number {
  const prevWidth = ctx.prevMaxBinId - ctx.prevMinBinId;
  const ageMs = Date.now() - new Date(ctx.prevCreatedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Calculate how far the price moved past the old range
  let overshoot = 0;
  if (currentActiveBinId > ctx.prevMaxBinId) {
    overshoot = currentActiveBinId - ctx.prevMaxBinId;
  } else if (currentActiveBinId < ctx.prevMinBinId) {
    overshoot = ctx.prevMinBinId - currentActiveBinId;
  }

  let multiplier = 1.0;

  // If out of range within 1 hour → very aggressive widening (2.5x)
  // Within 4 hours → strong widening (2x)
  // Within 12 hours → moderate widening (1.5x)
  if (ageHours < 1) {
    multiplier = 2.5;
  } else if (ageHours < 4) {
    multiplier = 2.0;
  } else if (ageHours < 12) {
    multiplier = 1.5;
  } else {
    multiplier = 1.2;
  }

  // Additional widening based on overshoot relative to old range
  if (prevWidth > 0 && overshoot > 0) {
    const overshootRatio = overshoot / prevWidth;
    // If price overshot by more than the entire old range, widen even more
    if (overshootRatio > 1.0) {
      multiplier *= 1.3;
    } else if (overshootRatio > 0.5) {
      multiplier *= 1.15;
    }
  }

  // Additional widening if this is a repeated rebalance
  if (ctx.rebalanceCount >= 2) {
    multiplier *= 1.2; // each repeated rebalance widens more
  }

  const widened = Math.round(baseWidth * multiplier);

  return widened;
}

/**
 * Main optimization function: given a scored pool, determine the optimal
 * strategy configuration for a single-sided SOL LP position.
 *
 * Uses momentum-aware widening to handle trending tokens better.
 * When rebalanceCtx is provided, also factors in how the previous position
 * performed (how fast it went out of range, price direction, rebalance count).
 */
export async function optimizeStrategy(
  pool: ScoredPool,
  rebalanceCtx?: RebalanceContext
): Promise<StrategyConfig> {
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

  // If rebalancing, apply additional widening based on previous position performance
  if (rebalanceCtx) {
    const prevWidth = rebalanceCtx.prevMaxBinId - rebalanceCtx.prevMinBinId;
    const ageMs = Date.now() - new Date(rebalanceCtx.prevCreatedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    binRangeWidth = applyRebalanceWidening(binRangeWidth, rebalanceCtx, activeBinId);

    logger.info('Rebalance-aware widening applied', {
      pool: pool.name,
      prevWidth,
      ageHours: ageHours.toFixed(1),
      rebalanceCount: rebalanceCtx.rebalanceCount,
      newWidth: binRangeWidth,
    });
  }

  // Ask OpenClaw AI for recommendation (falls back to rule-based if unavailable)
  const aiRec = await aiRecommendStrategy(pool, activeBinId, rebalanceCtx);
  if (aiRec) {
    strategyType = aiRec.strategyType;
    // For rebalance: use the max of AI recommendation and our rebalance-widened width
    // This ensures the AI can't accidentally pick a narrower range than what we know is needed
    if (rebalanceCtx) {
      binRangeWidth = Math.max(aiRec.binRangeWidth, binRangeWidth);
    } else {
      binRangeWidth = aiRec.binRangeWidth;
    }
    logger.info('Using OpenClaw AI strategy', {
      pool: pool.name,
      strategy: aiRec.strategyType,
      binWidth: binRangeWidth,
      aiBinWidth: aiRec.binRangeWidth,
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
    isRebalance: !!rebalanceCtx,
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
