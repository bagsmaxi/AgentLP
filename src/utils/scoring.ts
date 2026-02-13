import { ScoringWeights, DEFAULT_SCORING_WEIGHTS, ScoredPool, MeteoraPairData } from '../types';
import { config } from '../config';
import { logger } from './logger';

/**
 * Normalize a value to [0, 1] using min-max normalization within a dataset
 */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

/**
 * Calculate volume momentum: how active is the pool recently vs overall.
 * A pool with 4h volume that's a large % of 24h volume is "hot" right now.
 * Returns 0-1 score (higher = more active recently).
 */
function calcMomentum(vol4h: number, vol24h: number): number {
  if (vol24h <= 0) return 0;
  // 4h is 1/6 of 24h. If vol4h/vol24h > 1/6 (16.7%), pool is trending up
  const ratio = vol4h / vol24h;
  // Normalize: 0 at ratio=0, 0.5 at ratio=0.167 (even), 1 at ratio>=0.5 (3x expected)
  return Math.min(ratio / 0.5, 1);
}

/**
 * Score a set of SOL-paired pools and return them ranked best-to-worst.
 *
 * Score formula:
 *   score = w1*norm(volume24h) + w2*norm(fees24h) + w3*norm(apr) +
 *           w4*norm(liquidity) + w5*(1 - norm(binStep)) + w6*historyBonus
 *           + 0.15 * momentum bonus (recent volume activity)
 */
export function scoreAndRankPools(
  pools: MeteoraPairData[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
  historicalBonuses: Map<string, number> = new Map(),
  filterOverrides?: { minVolume24h?: number; minLiquidity?: number }
): ScoredPool[] {
  // Filter: only SOL-paired, meets volume/liquidity thresholds, not hidden
  const solMint = config.tokens.SOL_MINT;
  const minVol = filterOverrides?.minVolume24h ?? config.poolFilters.minVolume24h;
  const minLiq = filterOverrides?.minLiquidity ?? config.poolFilters.minLiquidity;
  const filtered = pools.filter(p => {
    if (p.hide) return false;
    const hasSol = p.mint_x === solMint || p.mint_y === solMint;
    if (!hasSol) return false;
    if (p.trade_volume_24h < minVol) return false;
    const liquidity = parseFloat(p.liquidity) || 0;
    if (liquidity < minLiq) return false;
    return true;
  });

  if (filtered.length === 0) {
    logger.warn('No SOL pools passed filters');
    return [];
  }

  // Compute min/max for normalization
  const volumes = filtered.map(p => p.trade_volume_24h);
  const fees = filtered.map(p => p.fees_24h);
  const aprs = filtered.map(p => p.apr || 0);
  const liquidities = filtered.map(p => parseFloat(p.liquidity) || 0);
  const binSteps = filtered.map(p => p.bin_step);

  const minMax = (arr: number[]) => ({
    min: Math.min(...arr),
    max: Math.max(...arr),
  });

  const volRange = minMax(volumes);
  const feeRange = minMax(fees);
  const aprRange = minMax(aprs);
  const liqRange = minMax(liquidities);
  const binRange = minMax(binSteps);

  // Score each pool
  const scored: ScoredPool[] = filtered.map(p => {
    const liquidity = parseFloat(p.liquidity) || 0;
    const apr = p.apr || 0;
    const historyBonus = historicalBonuses.get(p.address) || 0;

    // Extract granular volume/fee data
    const vol4h = p.volume?.hour_4 || 0;
    const vol1h = p.volume?.hour_1 || 0;
    const fees4h = p.fees?.hour_4 || 0;
    const momentum = calcMomentum(vol4h, p.trade_volume_24h);

    const baseScore =
      weights.volumeWeight * normalize(p.trade_volume_24h, volRange.min, volRange.max) +
      weights.feesWeight * normalize(p.fees_24h, feeRange.min, feeRange.max) +
      weights.aprWeight * normalize(apr, aprRange.min, aprRange.max) +
      weights.liquidityWeight * normalize(liquidity, liqRange.min, liqRange.max) +
      weights.binStepWeight * (1 - normalize(p.bin_step, binRange.min, binRange.max)) +
      weights.historyWeight * Math.min(historyBonus, 1);

    // Momentum bonus: up to 15% extra for pools that are hot right now
    const score = baseScore + 0.15 * momentum;

    const solSide: 'X' | 'Y' = p.mint_x === solMint ? 'X' : 'Y';

    return {
      address: p.address,
      name: p.name,
      mintX: p.mint_x,
      mintY: p.mint_y,
      binStep: p.bin_step,
      currentPrice: p.current_price,
      volume24h: p.trade_volume_24h,
      volume4h: vol4h,
      volume1h: vol1h,
      fees24h: p.fees_24h,
      fees4h,
      feeApr: apr,
      liquidity,
      score,
      solSide,
      volumeMomentum: momentum,
    };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  logger.info('Pools scored and ranked', {
    total: pools.length,
    filtered: filtered.length,
    topPool: scored[0]?.name,
    topScore: scored[0]?.score.toFixed(4),
  });

  return scored;
}
