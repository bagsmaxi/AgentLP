import { Router, Request, Response } from 'express';
import { prisma } from '../db';

export const analyticsRouter = Router();

/**
 * GET /api/analytics?wallet=<address>
 * Returns performance analytics for a wallet.
 */
analyticsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string;
    if (!wallet) {
      res.status(400).json({ success: false, error: 'wallet query param required' });
      return;
    }

    // Total fees earned across all positions
    const positions = await prisma.position.findMany({
      where: { walletAddress: wallet },
    });

    const totalSolDeposited = positions.reduce((sum, p) => sum + p.solDeposited, 0);
    const totalFeesEarned = positions.reduce((sum, p) => sum + p.totalFeesEarned, 0);
    const totalRewardsEarned = positions.reduce((sum, p) => sum + p.totalRewardsEarned, 0);
    const activePositions = positions.filter(p => p.status === 'active').length;
    const closedPositions = positions.filter(p => p.status === 'closed').length;
    const totalRebalances = positions.reduce((sum, p) => sum + p.rebalanceCount, 0);

    // Performance logs summary
    const perfLogs = await prisma.performanceLog.findMany({
      where: { poolAddress: { in: positions.map(p => p.poolAddress) } },
      orderBy: { loggedAt: 'desc' },
      take: 50,
    });

    const outcomes = {
      profit: perfLogs.filter(l => l.outcome === 'profit').length,
      loss: perfLogs.filter(l => l.outcome === 'loss').length,
      breakeven: perfLogs.filter(l => l.outcome === 'breakeven').length,
    };

    res.json({
      success: true,
      data: {
        summary: {
          totalSolDeposited,
          totalFeesEarned,
          totalRewardsEarned,
          totalReturn: totalFeesEarned + totalRewardsEarned,
          activePositions,
          closedPositions,
          totalRebalances,
        },
        outcomes,
        recentLogs: perfLogs.slice(0, 20),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/analytics/learning
 * Returns current learning weights and top performing pools/strategies.
 */
analyticsRouter.get('/learning', async (_req: Request, res: Response) => {
  try {
    // Current weights
    const weights = await prisma.learningWeights.findFirst({
      orderBy: { updatedAt: 'desc' },
    });

    // Top pools by avg fees earned
    const topPools = await prisma.performanceLog.groupBy({
      by: ['poolAddress', 'strategy'],
      _avg: { feesEarned: true },
      _count: { id: true },
      orderBy: { _avg: { feesEarned: 'desc' } },
      take: 10,
    });

    // Strategy performance comparison
    const strategyPerf = await prisma.performanceLog.groupBy({
      by: ['strategy'],
      _avg: { feesEarned: true },
      _count: { id: true },
    });

    res.json({
      success: true,
      data: {
        weights: weights || 'Using defaults - no learning data yet',
        topPools,
        strategyPerformance: strategyPerf,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
