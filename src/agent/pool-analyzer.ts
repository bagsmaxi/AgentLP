import { config } from '../config';
import { prisma } from '../db';
import { MeteoraPairData, ScoredPool, ScoringWeights, DEFAULT_SCORING_WEIGHTS, DEGEN_SCORING_WEIGHTS, DEGEN_FILTER_OVERRIDES, AgentMode } from '../types';
import { scoreAndRankPools } from '../utils/scoring';
import { aiAnalyzePools } from '../services/openclaw';
import { logger } from '../utils/logger';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

let cachedPairs: MeteoraPairData[] = [];
let lastFetchTime = 0;
const CACHE_DURATION_MS = 5 * 60_000; // 5 minute cache

// Pre-computed pool rankings cache (refreshed in background)
const rankedCache = new Map<string, { pools: ScoredPool[]; timestamp: number }>();
const RANKED_CACHE_MS = 2 * 60_000; // 2 min cache for ranked results
let bgRefreshTimer: NodeJS.Timeout | null = null;

/**
 * Fetch all DLMM pairs from Meteora API
 */
export async function fetchAllPairs(): Promise<MeteoraPairData[]> {
  const now = Date.now();
  if (cachedPairs.length > 0 && now - lastFetchTime < CACHE_DURATION_MS) {
    return cachedPairs;
  }

  try {
    logger.info('Fetching all DLMM pairs from Meteora API...');
    const response = await fetch(config.meteora.pairAllEndpoint);
    if (!response.ok) {
      throw new Error(`Meteora API returned ${response.status}`);
    }
    const data = (await response.json()) as MeteoraPairData[];
    cachedPairs = data;
    lastFetchTime = now;
    logger.info('Fetched DLMM pairs', { count: data.length });
    return data;
  } catch (err) {
    logger.error('Failed to fetch DLMM pairs', { error: err });
    return cachedPairs; // return stale cache on error
  }
}

/**
 * Get historical performance bonuses from the learning engine.
 */
async function getHistoricalBonuses(): Promise<Map<string, number>> {
  const bonuses = new Map<string, number>();

  try {
    const logs = await prisma.performanceLog.groupBy({
      by: ['poolAddress'],
      _avg: { feesEarned: true },
      _count: { id: true },
    });

    if (logs.length === 0) return bonuses;

    const maxAvgFee = Math.max(...logs.map(l => l._avg.feesEarned || 0));
    if (maxAvgFee === 0) return bonuses;

    for (const log of logs) {
      const avgFee = log._avg.feesEarned || 0;
      const confidence = Math.min(log._count.id / 10, 1);
      const bonus = (avgFee / maxAvgFee) * confidence;
      bonuses.set(log.poolAddress, bonus);
    }
  } catch (err) {
    logger.error('Failed to load historical bonuses', { error: err });
  }

  return bonuses;
}

/**
 * Load learning weights from DB if available, else use defaults
 */
async function loadWeights(): Promise<ScoringWeights> {
  try {
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
  } catch (err) {
    logger.error('Failed to load weights', { error: err });
  }
  return DEFAULT_SCORING_WEIGHTS;
}

/**
 * Internal: do the full analysis pipeline (fetch + score + AI)
 */
async function _analyzeAndRank(topN: number, mode: AgentMode): Promise<ScoredPool[]> {
  const pairs = await fetchAllPairs();
  const bonuses = await getHistoricalBonuses();

  let ranked: ScoredPool[];

  if (mode === 'degen') {
    ranked = scoreAndRankPools(pairs, DEGEN_SCORING_WEIGHTS, bonuses, DEGEN_FILTER_OVERRIDES);
  } else {
    const weights = await loadWeights();
    ranked = scoreAndRankPools(pairs, weights, bonuses);
  }

  const candidates = ranked.slice(0, Math.max(topN, 10));

  // Ask AI to re-rank (falls back to rule-based if unavailable)
  const aiResult = await aiAnalyzePools(candidates, mode);
  let topPools: ScoredPool[];

  if (aiResult) {
    const aiRanking = aiResult.ranking || [];
    const aiOrderedPools: ScoredPool[] = [];

    for (const aiPool of aiRanking) {
      const found = candidates.find(p => p.address === aiPool.address);
      if (found) aiOrderedPools.push(found);
    }

    const selectedIdx = aiOrderedPools.findIndex(p => p.address === aiResult.selectedPoolAddress);
    if (selectedIdx > 0) {
      const [selected] = aiOrderedPools.splice(selectedIdx, 1);
      aiOrderedPools.unshift(selected);
    } else if (selectedIdx === -1) {
      const selected = candidates.find(p => p.address === aiResult.selectedPoolAddress);
      if (selected) aiOrderedPools.unshift(selected);
    }

    for (const pool of candidates) {
      if (!aiOrderedPools.some(p => p.address === pool.address)) {
        aiOrderedPools.push(pool);
      }
    }

    topPools = aiOrderedPools.slice(0, topN);
    logger.info('Pools re-ranked by AI', {
      aiPick: aiResult.selectedPoolName,
      riskLevel: aiResult.riskLevel,
      confidence: aiResult.confidence,
    });
  } else {
    topPools = candidates.slice(0, topN);
  }

  persistScores(topPools).catch(err =>
    logger.error('Failed to persist pool scores', { error: err })
  );

  return topPools;
}

/**
 * Main analysis function: fetch pools, score them, return ranked list.
 * Uses a 2-min cache so the API responds instantly. If cache is stale,
 * returns stale data immediately and refreshes in the background.
 */
export async function analyzeAndRankPools(topN: number = 10, mode: AgentMode = 'assisted'): Promise<ScoredPool[]> {
  const cacheKey = `${mode}:${topN}`;
  const cached = rankedCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.timestamp < RANKED_CACHE_MS) {
    return cached.pools;
  }

  // If we have stale cache, return it immediately and refresh in background
  if (cached) {
    _analyzeAndRank(topN, mode).then(pools => {
      rankedCache.set(cacheKey, { pools, timestamp: Date.now() });
    }).catch(err => logger.error('Background pool refresh failed', { error: err }));
    return cached.pools;
  }

  // No cache at all — must wait for first load
  const pools = await _analyzeAndRank(topN, mode);
  rankedCache.set(cacheKey, { pools, timestamp: now });
  return pools;
}

/**
 * Start background refresh of pool rankings.
 * Called on server startup to pre-warm the cache.
 */
export function startPoolCacheRefresh() {
  // Pre-warm both modes
  _analyzeAndRank(10, 'assisted').then(pools => {
    rankedCache.set('assisted:10', { pools, timestamp: Date.now() });
    logger.info('Pool cache pre-warmed (assisted)');
  }).catch(() => {});

  _analyzeAndRank(10, 'degen').then(pools => {
    rankedCache.set('degen:10', { pools, timestamp: Date.now() });
    logger.info('Pool cache pre-warmed (degen)');
  }).catch(() => {});

  // Refresh every 2 minutes
  bgRefreshTimer = setInterval(() => {
    _analyzeAndRank(10, 'assisted').then(pools => {
      rankedCache.set('assisted:10', { pools, timestamp: Date.now() });
    }).catch(() => {});
    _analyzeAndRank(10, 'degen').then(pools => {
      rankedCache.set('degen:10', { pools, timestamp: Date.now() });
    }).catch(() => {});
  }, RANKED_CACHE_MS);
}

async function persistScores(pools: ScoredPool[]): Promise<void> {
  const records = pools.map(p => ({
    poolAddress: p.address,
    poolName: p.name,
    score: p.score,
    volume24h: p.volume24h,
    fees24h: p.fees24h,
    feeApr: p.feeApr,
    liquidity: p.liquidity,
    binStep: p.binStep,
  }));

  await prisma.poolScore.createMany({ data: records });
}

/**
 * Get a specific pool's data from the cached pair list
 */
export async function getPoolData(poolAddress: string): Promise<MeteoraPairData | undefined> {
  const pairs = await fetchAllPairs();
  return pairs.find(p => p.address === poolAddress);
}

/**
 * Find SOL-paired DLMM pools for a specific token mint.
 */
export async function getPoolsByMint(tokenMint: string): Promise<ScoredPool[]> {
  const pairs = await fetchAllPairs();

  const matching = pairs.filter(p => {
    const hasToken = p.mint_x === tokenMint || p.mint_y === tokenMint;
    if (!hasToken) return false;
    const hasSol = p.mint_x === SOL_MINT || p.mint_y === SOL_MINT;
    return hasSol;
  });

  if (matching.length === 0) {
    logger.info('No SOL pools found for token', { tokenMint });
    return [];
  }

  logger.info('Found SOL pools for token', { tokenMint, count: matching.length });

  const weights = await loadWeights();
  const bonuses = await getHistoricalBonuses();
  const scored = scoreAndRankPools(matching, weights, bonuses, {
    minVolume24h: 0,
    minLiquidity: 0,
  });

  return scored;
}
