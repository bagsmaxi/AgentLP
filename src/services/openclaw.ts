import { execFile } from 'child_process';
import { promisify } from 'util';
import { ScoredPool, AgentMode, StrategyName } from '../types';
import type { RebalanceContext } from '../agent/strategy-optimizer';
import { config } from '../config';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

// ── Response Types ──

export interface AIPoolSelection {
  selectedPoolAddress: string;
  selectedPoolName: string;
  ranking: Array<{
    address: string;
    name: string;
    aiScore: number;
    reasoning: string;
  }>;
  reasoning: string;
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  confidence: number;
}

export interface AIStrategyRecommendation {
  strategyType: StrategyName;
  binRangeWidth: number;
  reasoning: string;
  confidence: number;
}

// ── Cache ──

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const poolSelectionCache = new Map<string, CacheEntry<AIPoolSelection>>();
const strategyCache = new Map<string, CacheEntry<AIStrategyRecommendation>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > config.openclaw.cacheDurationMs) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// ── LPCLAW System Prompt ──

const LPCLAW_SYSTEM_PROMPT = `You are the LPCLAW AI analyst — an expert in Meteora DLMM liquidity provision on Solana.

## Meteora DLMM Background
- Meteora DLMM pools use concentrated liquidity with discrete price bins
- Each pool has a bin step (price increment between bins). Higher bin step = more volatile pair
- LPs deposit into a range of bins and earn fees only when price is in their range
- Single-sided deposits: you deposit only SOL on one side of the active price

## Strategy Types
- Spot (ID 0): Uniform distribution. Best for stable/low-vol pairs (binStep 1-5). Bin width: 50-70
- Curve (ID 1): Bell curve around active price. Best for medium-vol pairs (binStep 6-30). Bin width: 35-50
- BidAsk (ID 2): Concentrated on one side. Best for high-vol/memecoins (binStep 31+). Bin width: 25-42

## Volume Momentum (multi-signal: 1h intensity, 4h intensity, APR, volume/liquidity ratio)
- PARABOLIC (momentum >= 0.8): Token ripping — need 150%+ price range coverage. Recommend 150-250 bins for extreme binStep pools
- HOT (momentum >= 0.5): Very active trending — need wide range. Recommend 100-180 bins for high binStep
- RISING (momentum >= 0.3): Moderately active — wider than base. Recommend 50-100 bins
- CALM: Use base bin range
- For memecoins with binStep 80+, ALWAYS use very wide ranges (100+ bins minimum)

## Pool Health Evaluation
Positive: High volume relative to liquidity, consistent fees, reasonable APR, deep liquidity
Warning: APR >1000% with low volume (dead/manipulated), liquidity <$5K (rugpull risk), volume spike then decline (pump & dump)

You MUST always respond with ONLY valid JSON. No markdown, no extra text.`;

// ── Core Query Function ──

/**
 * Query Claude CLI using the user's Pro Max subscription.
 * Uses haiku model for fast, cost-effective analysis.
 */
async function queryClaude(prompt: string): Promise<string> {
  // Remove CLAUDECODE env var to avoid "nested session" error
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const args = [
    '-p',                           // print mode (one-shot)
    '--model', 'haiku',             // fast model for analysis
    '--output-format', 'text',      // text output (we parse JSON ourselves)
    '--no-session-persistence',     // don't save these sessions
    '--tools', '',                  // disable tools (reasoning only)
    '--system-prompt', LPCLAW_SYSTEM_PROMPT,
    prompt,
  ];

  const { stdout } = await execFileAsync('claude', args, {
    timeout: config.openclaw.timeout,
    env,
    maxBuffer: 1024 * 1024, // 1MB
  });

  return stdout.trim();
}

/**
 * Extract JSON from Claude response.
 * The model may wrap JSON in markdown code blocks or include extra text.
 */
function extractJSON(response: string): string {
  // Try to find JSON block in markdown
  const jsonBlockMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();

  // Try to find raw JSON object
  const jsonObjMatch = response.match(/\{[\s\S]*\}/);
  if (jsonObjMatch) return jsonObjMatch[0];

  return response;
}

// ── Pool Selection ──

/**
 * Ask Claude AI to analyze and rank pools for selection.
 * Uses the user's Claude Pro Max subscription via CLI.
 * Returns the AI's ranking with reasoning, or null if unavailable.
 */
export async function aiAnalyzePools(
  pools: ScoredPool[],
  mode: AgentMode
): Promise<AIPoolSelection | null> {
  if (!config.openclaw.enabled) return null;

  // Check cache
  const cacheKey = `${mode}:${pools.map(p => p.address).join(',')}`;
  const cached = getCached(poolSelectionCache, cacheKey);
  if (cached) {
    logger.info('AI pool selection cache hit');
    return cached;
  }

  try {
    const poolData = pools.map(p => ({
      address: p.address,
      name: p.name,
      binStep: p.binStep,
      volume24h: Math.round(p.volume24h),
      volume4h: Math.round(p.volume4h),
      volume1h: Math.round(p.volume1h),
      fees24h: Math.round(p.fees24h * 100) / 100,
      fees4h: Math.round(p.fees4h * 100) / 100,
      feeApr: Math.round(p.feeApr * 100) / 100,
      liquidity: Math.round(p.liquidity),
      volumeMomentum: Math.round(p.volumeMomentum * 100) / 100,
      ruleBasedScore: Math.round(p.score * 10000) / 10000,
    }));

    const modeInstructions = mode === 'degen'
      ? 'DEGEN MODE: Prioritize highest APR and momentum. Accept higher risk for higher potential returns. Prefer tokens with active trading volume.'
      : 'ASSISTED MODE: Balance safety and returns. Prefer established tokens with consistent volume and deep liquidity.';

    const prompt = `Analyze these Meteora DLMM pools and select the best one for SOL LP farming.

${modeInstructions}

Pool candidates (pre-filtered, all SOL-paired):
${JSON.stringify(poolData, null, 2)}

Respond with ONLY this JSON structure:
{"selectedPoolAddress":"address","selectedPoolName":"NAME","ranking":[{"address":"...","name":"...","aiScore":0.85,"reasoning":"brief"}],"reasoning":"1-2 sentence summary","riskLevel":"low|medium|high|extreme","confidence":0.85}`;

    logger.info('Querying Claude AI for pool selection', { mode, poolCount: pools.length });
    const response = await queryClaude(prompt);
    const jsonStr = extractJSON(response);
    const result = JSON.parse(jsonStr) as AIPoolSelection;

    // Validate the selected pool exists in our list
    const selectedExists = pools.some(p => p.address === result.selectedPoolAddress);
    if (!selectedExists) {
      logger.warn('AI selected unknown pool, falling back', {
        selected: result.selectedPoolAddress,
      });
      return null;
    }

    // Cache the result
    poolSelectionCache.set(cacheKey, { data: result, timestamp: Date.now() });

    logger.info('Claude AI pool selection', {
      selected: result.selectedPoolName,
      confidence: result.confidence,
      riskLevel: result.riskLevel,
      reasoning: result.reasoning,
    });

    return result;
  } catch (err) {
    logger.warn('Claude AI pool analysis failed, using rule-based fallback', {
      error: (err as Error).message,
    });
    return null;
  }
}

// ── Strategy Recommendation ──

/**
 * Ask Claude AI to recommend a strategy for a specific pool.
 * Returns strategy type and bin range width, or null if unavailable.
 */
export async function aiRecommendStrategy(
  pool: ScoredPool,
  activeBinId: number,
  rebalanceCtx?: RebalanceContext
): Promise<AIStrategyRecommendation | null> {
  if (!config.openclaw.enabled) return null;

  // Check cache — include rebalance info in key so rebalance gets fresh analysis
  const cacheKey = `${pool.address}:${activeBinId}:${rebalanceCtx ? 'rebal' : 'new'}`;
  const cached = getCached(strategyCache, cacheKey);
  if (cached) {
    logger.info('AI strategy cache hit');
    return cached;
  }

  try {
    const momentum = pool.volumeMomentum || 0;
    const momentumLabel = momentum >= 0.7 ? 'HOT' : momentum >= 0.4 ? 'RISING' : 'CALM';

    let rebalanceSection = '';
    if (rebalanceCtx) {
      const ageMs = Date.now() - new Date(rebalanceCtx.prevCreatedAt).getTime();
      const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
      const prevWidth = rebalanceCtx.prevMaxBinId - rebalanceCtx.prevMinBinId;

      let direction = 'unknown';
      if (activeBinId > rebalanceCtx.prevMaxBinId) direction = 'UP (price rose above range)';
      else if (activeBinId < rebalanceCtx.prevMinBinId) direction = 'DOWN (price fell below range)';

      rebalanceSection = `
## REBALANCE CONTEXT (CRITICAL — previous position went out of range)
- Previous range: bins ${rebalanceCtx.prevMinBinId} to ${rebalanceCtx.prevMaxBinId} (${prevWidth} bins)
- Previous position age: ${ageHours} hours
- Price moved: ${direction}
- Current active bin: ${activeBinId} (moved past the old range)
- Times rebalanced: ${rebalanceCtx.rebalanceCount}

The previous range of ${prevWidth} bins was TOO NARROW. The price broke out in ${ageHours} hours.
You MUST recommend a SIGNIFICANTLY WIDER range. At minimum ${Math.round(prevWidth * 1.5)} bins, ideally ${Math.round(prevWidth * 2)}+ bins.
The faster the breakout (fewer hours), the wider you should go.`;
    }

    const prompt = `Recommend an LP strategy for this Meteora DLMM pool.

Pool: ${pool.name}
Bin Step: ${pool.binStep}
Active Bin ID: ${activeBinId}
24h Volume: $${Math.round(pool.volume24h)}
4h Volume: $${Math.round(pool.volume4h)}
1h Volume: $${Math.round(pool.volume1h)}
24h Fees: $${(pool.fees24h).toFixed(2)}
Fee APR: ${pool.feeApr.toFixed(1)}%
Liquidity: $${Math.round(pool.liquidity)}
SOL Side: ${pool.solSide}
Volume Momentum: ${momentum.toFixed(2)} (${momentumLabel})
${rebalanceSection}

IMPORTANT: For ${momentumLabel} tokens, recommend WIDER bin ranges to avoid going out of range.
${rebalanceCtx ? 'THIS IS A REBALANCE — the previous range was too narrow. Go MUCH wider.' : ''}
For binStep ${pool.binStep} pools:
${pool.binStep >= 60 ? `- This is an EXTREME volatility pool (memecoin). Minimum 69 bins baseline.
- PARABOLIC: 150-250 bins (120-200% price range)
- HOT: 100-180 bins
- RISING: 69-100 bins
- CALM: 69 bins` : `- Spot: 50-70 bins (widen for momentum)
- Curve: 35-50 bins (widen for momentum)
- BidAsk: 25-42 bins (widen for momentum)`}

Respond with ONLY this JSON:
{"strategyType":"Spot|Curve|BidAsk","binRangeWidth":30,"reasoning":"brief","confidence":0.80}`;

    logger.info('Querying Claude AI for strategy', { pool: pool.name });
    const response = await queryClaude(prompt);
    const jsonStr = extractJSON(response);
    const result = JSON.parse(jsonStr) as AIStrategyRecommendation;

    // Validate strategy type
    if (!['Spot', 'Curve', 'BidAsk'].includes(result.strategyType)) {
      logger.warn('AI returned invalid strategy type', { type: result.strategyType });
      return null;
    }

    // Validate bin range
    if (result.binRangeWidth < 4 || result.binRangeWidth > 69) {
      logger.warn('AI returned out-of-range bin width', { width: result.binRangeWidth });
      return null;
    }

    // Cache
    strategyCache.set(cacheKey, { data: result, timestamp: Date.now() });

    logger.info('Claude AI strategy recommendation', {
      pool: pool.name,
      strategy: result.strategyType,
      binWidth: result.binRangeWidth,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });

    return result;
  } catch (err) {
    logger.warn('Claude AI strategy recommendation failed, using rule-based fallback', {
      error: (err as Error).message,
    });
    return null;
  }
}
