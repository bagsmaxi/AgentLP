import { prisma } from '../db';
import { DEFAULT_SCORING_WEIGHTS, ScoringWeights } from '../types';
import { logger } from '../utils/logger';

/**
 * Learning Engine
 *
 * Tracks which pools, strategies, and bin widths produce the best returns.
 * Periodically adjusts scoring weights to improve pool selection over time.
 *
 * Learning approach:
 * - If high-volume pools consistently outperform -> increase volume weight
 * - If high-fee pools consistently outperform -> increase fee weight
 * - If APR is a better predictor of actual returns -> increase APR weight
 * - Uses simple gradient-based adjustment on actual performance data
 */

const LEARNING_RATE = 0.02; // Small adjustment per learning cycle
const MIN_DATA_POINTS = 5;  // Need at least this many data points to learn

/**
 * Run a learning cycle: analyze recent performance and adjust weights.
 * Should be called periodically (e.g., every few hours or daily).
 */
export async function runLearningCycle(): Promise<ScoringWeights | null> {
  try {
    // Get performance logs with associated pool scores
    const logs = await prisma.performanceLog.findMany({
      orderBy: { loggedAt: 'desc' },
      take: 100,
    });

    if (logs.length < MIN_DATA_POINTS) {
      logger.info('Not enough data for learning cycle', { count: logs.length });
      return null;
    }

    // Get pool scores at the time of each position creation
    const poolScores = await prisma.poolScore.findMany({
      where: {
        poolAddress: { in: logs.map(l => l.poolAddress) },
      },
      orderBy: { scoredAt: 'desc' },
    });

    // Build a map of pool -> latest score components
    const scoreMap = new Map<string, {
      volume24h: number;
      fees24h: number;
      feeApr: number;
      liquidity: number;
      binStep: number;
    }>();

    for (const score of poolScores) {
      if (!scoreMap.has(score.poolAddress)) {
        scoreMap.set(score.poolAddress, {
          volume24h: score.volume24h,
          fees24h: score.fees24h,
          feeApr: score.feeApr,
          liquidity: score.liquidity,
          binStep: score.binStep,
        });
      }
    }

    // Calculate correlation between each scoring factor and actual fees earned
    const correlations = computeCorrelations(logs, scoreMap);

    // Load current weights
    const currentWeights = await loadCurrentWeights();

    // Adjust weights based on correlations
    const newWeights = adjustWeights(currentWeights, correlations);

    // Save new weights
    await prisma.learningWeights.create({
      data: {
        volumeWeight: newWeights.volumeWeight,
        feesWeight: newWeights.feesWeight,
        aprWeight: newWeights.aprWeight,
        liquidityWeight: newWeights.liquidityWeight,
        binStepWeight: newWeights.binStepWeight,
        historyWeight: newWeights.historyWeight,
      },
    });

    logger.info('Learning cycle completed', {
      oldWeights: currentWeights,
      newWeights,
      correlations,
    });

    return newWeights;
  } catch (err) {
    logger.error('Learning cycle failed', { error: err });
    return null;
  }
}

/**
 * Compute simple correlations between pool features and actual fees earned.
 */
function computeCorrelations(
  logs: Array<{ poolAddress: string; feesEarned: number }>,
  scoreMap: Map<string, { volume24h: number; fees24h: number; feeApr: number; liquidity: number; binStep: number }>
): Record<string, number> {
  const features = ['volume24h', 'fees24h', 'feeApr', 'liquidity', 'binStep'] as const;
  const correlations: Record<string, number> = {};

  for (const feature of features) {
    const pairs: Array<[number, number]> = [];

    for (const log of logs) {
      const poolData = scoreMap.get(log.poolAddress);
      if (poolData) {
        pairs.push([poolData[feature], log.feesEarned]);
      }
    }

    if (pairs.length >= MIN_DATA_POINTS) {
      correlations[feature] = pearsonCorrelation(pairs);
    } else {
      correlations[feature] = 0;
    }
  }

  return correlations;
}

/**
 * Pearson correlation coefficient between two variables.
 */
function pearsonCorrelation(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n === 0) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Adjust weights based on correlation signals.
 * Increase weight for features that correlate positively with fees earned.
 * Decrease weight for features with negative or no correlation.
 */
function adjustWeights(
  current: ScoringWeights,
  correlations: Record<string, number>
): ScoringWeights {
  const featureToWeight: Record<string, keyof ScoringWeights> = {
    volume24h: 'volumeWeight',
    fees24h: 'feesWeight',
    feeApr: 'aprWeight',
    liquidity: 'liquidityWeight',
    binStep: 'binStepWeight',
  };

  const adjusted = { ...current };

  for (const [feature, weightKey] of Object.entries(featureToWeight)) {
    const correlation = correlations[feature] || 0;
    // Nudge weight in the direction of the correlation
    const delta = LEARNING_RATE * correlation;
    adjusted[weightKey] = Math.max(0.01, Math.min(0.5, adjusted[weightKey] + delta));
  }

  // Normalize weights to sum to ~1 (excluding historyWeight)
  const mainWeights: (keyof ScoringWeights)[] = [
    'volumeWeight', 'feesWeight', 'aprWeight', 'liquidityWeight', 'binStepWeight',
  ];
  const mainSum = mainWeights.reduce((s, k) => s + adjusted[k], 0);
  const targetSum = 1 - adjusted.historyWeight;

  for (const key of mainWeights) {
    adjusted[key] = (adjusted[key] / mainSum) * targetSum;
  }

  return adjusted;
}

async function loadCurrentWeights(): Promise<ScoringWeights> {
  const latest = await prisma.learningWeights.findFirst({
    orderBy: { updatedAt: 'desc' },
  });

  if (latest) {
    return {
      volumeWeight: latest.volumeWeight,
      feesWeight: latest.feesWeight,
      aprWeight: latest.aprWeight,
      liquidityWeight: latest.liquidityWeight,
      binStepWeight: latest.binStepWeight,
      historyWeight: latest.historyWeight,
    };
  }

  return DEFAULT_SCORING_WEIGHTS;
}

/**
 * Get learning insights for display.
 */
export async function getLearningInsights() {
  const weights = await loadCurrentWeights();

  // Best performing strategies
  const strategyStats = await prisma.performanceLog.groupBy({
    by: ['strategy'],
    _avg: { feesEarned: true },
    _count: { id: true },
    _sum: { feesEarned: true },
  });

  // Best performing bin widths
  const binWidthStats = await prisma.performanceLog.groupBy({
    by: ['binWidth'],
    _avg: { feesEarned: true },
    _count: { id: true },
  });

  return {
    currentWeights: weights,
    strategyPerformance: strategyStats,
    binWidthPerformance: binWidthStats.sort(
      (a, b) => (b._avg.feesEarned || 0) - (a._avg.feesEarned || 0)
    ),
  };
}
