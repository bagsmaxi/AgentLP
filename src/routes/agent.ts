import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { analyzeAndRankPools, getPoolsByMint } from '../agent/pool-analyzer';
import { buildAndExecutePosition, preparePositionTransaction } from '../agent/tx-builder';
import { optimizeStrategy, quickClassify } from '../agent/strategy-optimizer';
import { startMonitoring, stopMonitoring } from '../agent/position-monitor';
import { getSolBalance } from '../services/solana';
import { StartSessionRequest, ApiResponse } from '../types';
import { logger } from '../utils/logger';

// Reserve SOL for rent (position account ~0.003 + 2 ATAs ~0.004) + tx fees + buffer
const RENT_RESERVE_SOL = 0.05;

export const agentRouter = Router();

// Track active auto-mode sessions
const activeSessions = new Map<string, string>(); // sessionId -> walletAddress

/**
 * POST /api/agent/start
 * Start an agent session.
 *
 * Both "normal" and "degen" modes auto-pick the best pool.
 * Normal = safe, balanced scoring. Degen = chase highest APR.
 */
agentRouter.post('/start', async (req: Request, res: Response) => {
  try {
    const { walletAddress, mode, solAmount, keypairPath, tokenMint } = req.body as StartSessionRequest;

    if (!walletAddress || !mode || !solAmount) {
      res.status(400).json({
        success: false,
        error: 'walletAddress, mode, and solAmount are required',
      });
      return;
    }

    if (mode !== 'assisted' && mode !== 'degen') {
      res.status(400).json({
        success: false,
        error: 'mode must be "assisted" or "degen"',
      });
      return;
    }

    if (mode === 'assisted' && !tokenMint) {
      res.status(400).json({
        success: false,
        error: 'tokenMint is required for assisted mode',
      });
      return;
    }

    // Check wallet balance before proceeding
    const balance = await getSolBalance(walletAddress);
    const requiredBalance = solAmount + RENT_RESERVE_SOL;
    if (balance < requiredBalance) {
      res.status(400).json({
        success: false,
        error: `Insufficient balance. You have ${balance.toFixed(4)} SOL but need ~${requiredBalance.toFixed(4)} SOL (${solAmount} deposit + ~${RENT_RESERVE_SOL} for rent & fees). Try depositing ${Math.max(0, balance - RENT_RESERVE_SOL).toFixed(4)} SOL instead.`,
      });
      return;
    }

    // Create session record
    const session = await prisma.agentSession.create({
      data: {
        walletAddress,
        mode,
        solCommitted: solAmount,
        status: 'running',
      },
    });

    logger.info('Agent session started', { sessionId: session.id, mode, solAmount });

    // Pick pool based on mode
    let pools: Awaited<ReturnType<typeof analyzeAndRankPools>>;
    if (mode === 'assisted' && tokenMint) {
      pools = await getPoolsByMint(tokenMint);
      if (pools.length === 0) {
        res.status(404).json({
          success: false,
          error: 'No SOL pools found for this token on Meteora. Make sure the token has a DLMM pool paired with SOL.',
        });
        return;
      }
    } else {
      // DEGEN mode: agent picks best pool using APR-heavy scoring
      pools = await analyzeAndRankPools(5, mode);
    }

    if (pools.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No suitable SOL pools found',
      });
      return;
    }

    const bestPool = pools[0];
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const pairedTokenMint = bestPool.mintX === SOL_MINT ? bestPool.mintY : bestPool.mintX;

    logger.info(`${mode} mode selected pool`, {
      pool: bestPool.name,
      score: bestPool.score.toFixed(4),
      pairedToken: pairedTokenMint,
    });

    if (keypairPath) {
      // Auto-sign: create position immediately
      const result = await buildAndExecutePosition({
        pool: bestPool,
        solAmount,
        walletAddress,
        keypairPath,
        mode,
        sessionId: session.id,
      });

      activeSessions.set(session.id, walletAddress);
      startMonitoring(walletAddress, keypairPath);

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          selectedPool: bestPool,
          position: result,
        },
      });
    } else {
      // Wallet adapter: prepare serialized transaction for client to sign
      const prepared = await preparePositionTransaction({
        pool: bestPool,
        solAmount,
        walletAddress,
      });

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          selectedPool: {
            ...bestPool,
            ...quickClassify(bestPool),
          },
          transaction: prepared.serializedTx,
          positionPubkey: prepared.positionPubkey,
          strategy: prepared.strategy,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          pairedTokenMint,
        },
      });
    }
  } catch (err) {
    logger.error('Failed to start agent', { error: err });
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/agent/stop
 * Stop an agent session and optionally close positions.
 */
agentRouter.post('/stop', async (req: Request, res: Response) => {
  try {
    const { sessionId, closePositions } = req.body;

    if (!sessionId) {
      res.status(400).json({ success: false, error: 'sessionId required' });
      return;
    }

    // Update session status
    await prisma.agentSession.update({
      where: { id: sessionId },
      data: { status: 'stopped', stoppedAt: new Date() },
    });

    // Stop monitoring
    const wallet = activeSessions.get(sessionId);
    if (wallet) {
      stopMonitoring(wallet);
      activeSessions.delete(sessionId);
    }

    logger.info('Agent session stopped', { sessionId });

    res.json({
      success: true,
      data: {
        sessionId,
        message: closePositions
          ? 'Session stopped. Positions will be closed.'
          : 'Session stopped. Positions remain active but unmonitored.',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/agent/sessions?wallet=<address>
 * Get all sessions for a wallet.
 */
agentRouter.get('/sessions', async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string;
    if (!wallet) {
      res.status(400).json({ success: false, error: 'wallet query param required' });
      return;
    }

    const sessions = await prisma.agentSession.findMany({
      where: { walletAddress: wallet },
      orderBy: { startedAt: 'desc' },
    });

    res.json({ success: true, data: sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
