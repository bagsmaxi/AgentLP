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
type VolatilityClass = 'low' | 'medium' | 'high' | 'extreme';

function classifyVolatility(pool: ScoredPool): VolatilityClass {
  // bin_step is in basis points: 1 = 0.01%, 100 = 1%
  if (pool.binStep <= 5) return 'low';
  if (pool.binStep <= 30) return 'medium';
  if (pool.binStep <= 60) return 'high';
  return 'extreme'; // binStep 61+ = memecoins on pump, extreme volatility
}

/**
 * Determine the base bin range width based on volatility.
 *
 * Price range covered = binRangeWidth × binStep (in basis points)
 * Example: 69 bins × 80bp = 55.2% price range for extreme tokens
 */
function getBaseBinRangeWidth(volatility: VolatilityClass, binStep: number): number {
  switch (volatility) {
    case 'low':
      return 60;     // stables: 60 bins × ~1-5bp = 0.6-3% range
    case 'medium':
      return 40;     // major pairs: 40 bins × ~10-25bp = 4-10% range
    case 'high':
      return 50;     // volatile: 50 bins × ~50-60bp = 25-30% range
    case 'extreme':
      // Memecoins need wide ranges. At binStep 80, each bin = 0.8% price move.
      // Base of 150 bins × 0.8% = covers ~3.3x pump before going out of range.
      // For higher binSteps (100+), fewer bins needed for same coverage.
      if (binStep >= 100) return 120;  // 120 bins × 1% = covers ~3.3x
      return 150;                       // 150 bins × 0.8% = covers ~3.3x
  }
}

/**
 * Calculate effective momentum using multiple time windows.
 * Uses 1h, 4h, and 12h volumes relative to 24h to detect:
 * - Spikes (1h is hot but 4h isn't)
 * - Sustained trends (both 1h and 4h are hot)
 * - Fading trends (12h is big but 1h/4h is calm)
 */
function calcEffectiveMomentum(pool: ScoredPool): {
  momentum: number;
  label: 'PARABOLIC' | 'HOT' | 'RISING' | 'CALM';
} {
  const vol1h = pool.volume1h || 0;
  const vol4h = pool.volume4h || 0;
  const vol24h = pool.volume24h || 0;

  if (vol24h <= 0) return { momentum: 0, label: 'CALM' };

  // Multiple signals:
  // 1. 1h intensity: how hot is it RIGHT NOW (1h is 1/24 of 24h = 4.2% expected)
  const ratio1h = vol1h / vol24h;
  const intensity1h = Math.min(ratio1h / 0.1, 1); // 1.0 at 10%+ (2.5x expected)

  // 2. 4h intensity: sustained activity (4h is 1/6 of 24h = 16.7% expected)
  const ratio4h = vol4h / vol24h;
  const intensity4h = Math.min(ratio4h / 0.33, 1); // 1.0 at 33%+ (2x expected)

  // 3. Fee APR signal: very high APR means active trading
  const aprSignal = pool.feeApr > 200 ? 1 : pool.feeApr > 100 ? 0.7 : pool.feeApr > 50 ? 0.4 : 0;

  // 4. Volume-to-liquidity ratio: high V/L means price is moving fast through bins
  const vlRatio = vol24h / Math.max(pool.liquidity, 1);
  const vlSignal = Math.min(vlRatio / 100, 1); // 1.0 at 100x volume vs liquidity

  // Weighted combination
  const momentum = Math.min(
    intensity1h * 0.35 + intensity4h * 0.30 + aprSignal * 0.20 + vlSignal * 0.15,
    1.0
  );

  let label: 'PARABOLIC' | 'HOT' | 'RISING' | 'CALM';
  if (momentum >= 0.8 || (intensity1h >= 0.8 && vlRatio > 50)) {
    label = 'PARABOLIC';
  } else if (momentum >= 0.5) {
    label = 'HOT';
  } else if (momentum >= 0.3) {
    label = 'RISING';
  } else {
    label = 'CALM';
  }

  return { momentum, label };
}

/**
 * Apply momentum-aware widening to the bin range.
 * PARABOLIC tokens get extreme widening to handle 100%+ price moves.
 */
function applyMomentumWidening(
  baseWidth: number,
  momentum: number,
  label: string,
  binStep: number,
): number {
  let multiplier = 1.0;

  if (label === 'PARABOLIC') {
    // Token going parabolic — need massive range to cover 5-10x moves
    multiplier = 2.5;
  } else if (label === 'HOT') {
    // Very active trending — cover 3-5x moves
    multiplier = 1.8;
  } else if (label === 'RISING') {
    // Moderately active — cover 2-3x moves
    multiplier = 1.3;
  }
  // CALM stays at 1.0 — base width already accounts for typical volatility

  // Extra widening for extreme binStep pools (80+) — memecoins can spike any time
  // Even "calm" memecoins can suddenly pump, so apply minimum 1.0 (base already wide)
  if (binStep >= 80 && multiplier > 1.0) {
    multiplier *= 1.15;
  }

  return Math.round(baseWidth * multiplier);
}

/**
 * Select the best strategy type based on volatility.
 */
function selectStrategy(volatility: VolatilityClass): StrategyName {
  switch (volatility) {
    case 'low':
      return 'Spot';
    case 'medium':
      return 'Curve';
    case 'high':
    case 'extreme':
      return 'BidAsk';
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
    return {
      minBinId: activeBinId + 1,
      maxBinId: activeBinId + binRangeWidth,
    };
  } else {
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
  prevActiveBinId?: number;
  rebalanceCount: number;
}

/**
 * Apply rebalance-aware widening based on how the previous position performed.
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

  // Aggressive time-based multiplier
  if (ageHours < 0.5) {
    multiplier = 4.0;   // out of range in < 30 min = absolutely ripping
  } else if (ageHours < 1) {
    multiplier = 3.0;
  } else if (ageHours < 4) {
    multiplier = 2.0;
  } else if (ageHours < 12) {
    multiplier = 1.5;
  } else {
    multiplier = 1.2;
  }

  // Overshoot-based widening
  if (prevWidth > 0 && overshoot > 0) {
    const overshootRatio = overshoot / prevWidth;
    if (overshootRatio > 2.0) {
      multiplier *= 1.5;   // price blew through 2x the old range
    } else if (overshootRatio > 1.0) {
      multiplier *= 1.3;
    } else if (overshootRatio > 0.5) {
      multiplier *= 1.15;
    }
  }

  // Repeated rebalance penalty
  if (ctx.rebalanceCount >= 3) {
    multiplier *= 1.5;
  } else if (ctx.rebalanceCount >= 2) {
    multiplier *= 1.3;
  }

  // Ensure new range is at least as wide as: previous width + overshoot
  const minRequired = prevWidth + overshoot;
  const widened = Math.max(Math.round(baseWidth * multiplier), minRequired);

  return widened;
}

/**
 * Main optimization function: given a scored pool, determine the optimal
 * strategy configuration for a single-sided SOL LP position.
 *
 * Uses multi-signal momentum analysis and volatility classification to
 * determine bin range width. For extreme/parabolic tokens, uses very
 * wide ranges to avoid frequent rebalancing.
 */
export async function optimizeStrategy(
  pool: ScoredPool,
  rebalanceCtx?: RebalanceContext
): Promise<StrategyConfig> {
  const meteora = getMeteoraService();

  const dlmmPool = await meteora.getPool(pool.address);
  const activeBin = await meteora.getActiveBin(dlmmPool);
  const activeBinId = activeBin.binId;

  // Classify volatility and compute momentum
  const volatility = classifyVolatility(pool);
  let strategyType = selectStrategy(volatility);
  const baseWidth = getBaseBinRangeWidth(volatility, pool.binStep);

  const { momentum, label: momentumLabel } = calcEffectiveMomentum(pool);
  let binRangeWidth = applyMomentumWidening(baseWidth, momentum, momentumLabel, pool.binStep);

  // If rebalancing, apply additional widening
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

  // Ask OpenClaw AI for recommendation (falls back to rule-based)
  const aiRec = await aiRecommendStrategy(pool, activeBinId, rebalanceCtx);
  if (aiRec) {
    strategyType = aiRec.strategyType;
    // Always use the wider of AI vs rule-based (safety floor)
    if (rebalanceCtx || momentumLabel === 'PARABOLIC') {
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

  // Meteora DLMM: POSITION_MAX_LENGTH = 1400 bins max per position.
  // Positions > 69 bins require multi-step creation (init → resize → add liquidity)
  // due to Solana's 10KB-per-instruction realloc limit. MeteoraService handles this.
  const MAX_BINS = 1400;
  if (binRangeWidth > MAX_BINS) {
    logger.info('Capping bin range to Meteora POSITION_MAX_LENGTH', {
      requested: binRangeWidth,
      capped: MAX_BINS,
    });
    binRangeWidth = MAX_BINS;
  }

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
    momentumLabel,
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
 */
export function quickClassify(pool: ScoredPool): {
  volatility: VolatilityClass;
  suggestedStrategy: StrategyName;
  suggestedBinWidth: number;
} {
  const volatility = classifyVolatility(pool);
  const baseWidth = getBaseBinRangeWidth(volatility, pool.binStep);
  const { momentum, label } = calcEffectiveMomentum(pool);
  return {
    volatility,
    suggestedStrategy: selectStrategy(volatility),
    suggestedBinWidth: applyMomentumWidening(baseWidth, momentum, label, pool.binStep),
  };
}
