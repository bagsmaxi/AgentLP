import { Router, Request, Response } from 'express';
import { analyzeAndRankPools, getPoolData } from '../agent/pool-analyzer';
import { quickClassify } from '../agent/strategy-optimizer';
import { ApiResponse, ScoredPool, AgentMode } from '../types';

export const poolsRouter = Router();

/**
 * GET /api/pools
 * Returns top ranked SOL pools with scores and suggested strategies.
 *
 * Query params:
 *   limit - number of pools to return (default 10)
 *   fresh - if "true", include fresh/new pairs with lower thresholds
 */
poolsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const topN = parseInt(req.query.limit as string) || 10;
    const mode = (req.query.mode as AgentMode) || 'assisted';
    const pools = await analyzeAndRankPools(topN, mode);

    const enriched = pools.map(pool => ({
      ...pool,
      ...quickClassify(pool),
    }));

    const response: ApiResponse<typeof enriched> = {
      success: true,
      data: enriched,
    };
    res.json(response);
  } catch (err) {
    const response: ApiResponse<null> = {
      success: false,
      error: (err as Error).message,
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/pools/:address
 * Returns detailed info for a specific pool.
 */
poolsRouter.get('/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const poolData = await getPoolData(address);

    if (!poolData) {
      res.status(404).json({ success: false, error: 'Pool not found' });
      return;
    }

    res.json({ success: true, data: poolData });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
