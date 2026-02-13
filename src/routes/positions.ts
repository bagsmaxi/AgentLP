import { Router, Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { prisma } from '../db';
import { buildAndExecutePosition, preparePositionTransaction, confirmPosition, prepareClosePositionTransaction, confirmClosePosition } from '../agent/tx-builder';
import { analyzeAndRankPools } from '../agent/pool-analyzer';
import { getSolBalance } from '../services/solana';
import { getMeteoraService } from '../services/meteora';
import { prepareSwapToSol, getNonSolMint } from '../services/jupiter';
import { createNotification } from './notifications';
import { ApiResponse, CreatePositionRequest, AgentMode } from '../types';
import { logger } from '../utils/logger';

// Reserve SOL for rent (position account ~0.003 + 2 ATAs ~0.004) + tx fees + buffer
const RENT_RESERVE_SOL = 0.05;

export const positionsRouter = Router();

/**
 * Fetch on-chain unclaimed fees for active positions.
 * Groups positions by pool to minimize RPC calls.
 */
async function fetchOnChainFees(
  positions: any[],
  walletAddress: string
): Promise<Map<string, number>> {
  const fees = new Map<string, number>();
  const activePositions = positions.filter(p => p.status === 'active');
  if (activePositions.length === 0) return fees;

  // Group positions by pool address to avoid loading the same pool multiple times
  const byPool = new Map<string, typeof activePositions>();
  for (const pos of activePositions) {
    const list = byPool.get(pos.poolAddress) || [];
    list.push(pos);
    byPool.set(pos.poolAddress, list);
  }

  const meteora = getMeteoraService();
  const ownerPubkey = new PublicKey(walletAddress);

  // Fetch fees for each pool group in parallel using positionBinData (actual claimable fees)
  const poolPromises = Array.from(byPool.entries()).map(async ([poolAddress, poolPositions]) => {
    try {
      const pool = await meteora.getPool(poolAddress);
      const positionFees = await meteora.getClaimableFees(pool, ownerPubkey);

      for (const pos of poolPositions) {
        const feeSol = positionFees.get(pos.positionPubkey) || 0;
        fees.set(pos.id, feeSol);
      }
    } catch (err) {
      logger.warn('Failed to fetch on-chain fees for pool', {
        poolAddress,
        error: (err as Error).message,
      });
    }
  });

  await Promise.all(poolPromises);
  return fees;
}

/**
 * GET /api/positions?wallet=<address>
 * Returns all positions for a wallet, enriched with on-chain unclaimed fees.
 */
positionsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const wallet = req.query.wallet as string;
    if (!wallet) {
      res.status(400).json({ success: false, error: 'wallet query param required' });
      return;
    }

    const positions = await prisma.position.findMany({
      where: { walletAddress: wallet },
      orderBy: { createdAt: 'desc' },
    });

    // Fetch on-chain unclaimed fees for active positions
    const onChainFees = await fetchOnChainFees(positions, wallet);

    // Enrich positions with on-chain fee data
    const enriched = positions.map(pos => {
      const unclaimedFees = onChainFees.get(pos.id) || 0;
      return {
        ...pos,
        // Total = previously claimed (in DB) + currently unclaimed (on-chain)
        totalFeesEarned: pos.totalFeesEarned + unclaimedFees,
        unclaimedFees,
      };
    });

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/positions/:id
 * Returns a single position with details.
 */
positionsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const position = await prisma.position.findUnique({
      where: { id: req.params.id },
    });

    if (!position) {
      res.status(404).json({ success: false, error: 'Position not found' });
      return;
    }

    res.json({ success: true, data: position });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/positions/create
 * Create a new LP position (Assisted mode).
 *
 * Body: { walletAddress, poolAddress, solAmount, keypairPath? }
 *
 * If keypairPath provided: auto-signs and returns signature.
 * Otherwise: returns serialized transaction for wallet adapter.
 */
positionsRouter.post('/create', async (req: Request, res: Response) => {
  try {
    const { walletAddress, poolAddress, solAmount, keypairPath } = req.body as CreatePositionRequest;

    if (!walletAddress || !poolAddress || !solAmount) {
      res.status(400).json({
        success: false,
        error: 'walletAddress, poolAddress, and solAmount are required',
      });
      return;
    }

    // Check wallet balance
    const balance = await getSolBalance(walletAddress);
    const required = solAmount + RENT_RESERVE_SOL;
    if (balance < required) {
      res.status(400).json({
        success: false,
        error: `Insufficient balance. You have ${balance.toFixed(4)} SOL but need ~${required.toFixed(4)} SOL (${solAmount} deposit + ~${RENT_RESERVE_SOL} for rent & fees). Try ${Math.max(0, balance - RENT_RESERVE_SOL).toFixed(4)} SOL instead.`,
      });
      return;
    }

    // Find the pool in our ranked list
    const ranked = await analyzeAndRankPools(50);
    const pool = ranked.find(p => p.address === poolAddress);

    if (!pool) {
      res.status(404).json({ success: false, error: 'Pool not found or does not meet criteria' });
      return;
    }

    const positionMode: AgentMode = (req.body.mode as AgentMode) || 'assisted';

    if (keypairPath) {
      // Auto-sign mode
      const result = await buildAndExecutePosition({
        pool,
        solAmount,
        walletAddress,
        keypairPath,
        mode: positionMode,
      });
      res.json({ success: true, data: result });
    } else {
      // Wallet adapter mode - prepare transaction
      const prepared = await preparePositionTransaction({
        pool,
        solAmount,
        walletAddress,
      });
      res.json({ success: true, data: prepared });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/positions/confirm
 * Confirm a position after client-side signing (wallet adapter mode).
 *
 * Body: { walletAddress, poolAddress, poolName, positionPubkey, solDeposited, strategy }
 */
positionsRouter.post('/confirm', async (req: Request, res: Response) => {
  try {
    await confirmPosition(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/positions/:id/close
 * Prepare transaction(s) to close a position and remove all liquidity.
 * Returns serialized transaction(s) for the frontend wallet to sign.
 *
 * Body: { walletAddress: string }
 */
positionsRouter.post('/:id/close', async (req: Request, res: Response) => {
  const positionId = req.params.id;
  const { walletAddress } = req.body;
  try {

    if (!walletAddress) {
      res.status(400).json({ success: false, error: 'walletAddress is required' });
      return;
    }

    const result = await prepareClosePositionTransaction({
      positionId,
      walletAddress,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    const errMsg = (err as Error).message || '';
    // If the on-chain position account no longer exists, just mark it closed in DB
    if (errMsg.toLowerCase().includes('account does not exist') || errMsg.toLowerCase().includes('not found on-chain')) {
      try {
        await confirmClosePosition({ positionId, walletAddress });
        res.json({
          success: true,
          data: { serializedTxs: [], blockhash: '', lastValidBlockHeight: 0, alreadyClosed: true },
        });
      } catch (closeErr) {
        res.status(500).json({ success: false, error: (closeErr as Error).message });
      }
      return;
    }
    res.status(500).json({ success: false, error: errMsg });
  }
});

/**
 * POST /api/positions/:id/close-confirm
 * After the user has signed and confirmed the close transaction(s),
 * mark the position as closed in the DB.
 *
 * Body: { walletAddress: string }
 */
positionsRouter.post('/:id/close-confirm', async (req: Request, res: Response) => {
  try {
    const positionId = req.params.id;
    const { walletAddress } = req.body;

    if (!walletAddress) {
      res.status(400).json({ success: false, error: 'walletAddress is required' });
      return;
    }

    await confirmClosePosition({ positionId, walletAddress });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/positions/:id/rebalance
 * Prepare rebalance: close old position + prepare new position at current price.
 * Returns serialized transactions for wallet adapter signing.
 *
 * Body: { walletAddress: string }
 */
positionsRouter.post('/:id/rebalance', async (req: Request, res: Response) => {
  const positionId = req.params.id;
  const { walletAddress } = req.body;

  try {
    if (!walletAddress) {
      res.status(400).json({ success: false, error: 'walletAddress is required' });
      return;
    }

    const position = await prisma.position.findUnique({
      where: { id: positionId },
    });
    if (!position) {
      res.status(404).json({ success: false, error: 'Position not found' });
      return;
    }
    if (position.status !== 'active') {
      res.status(400).json({ success: false, error: 'Position is not active' });
      return;
    }
    if (position.walletAddress !== walletAddress) {
      res.status(403).json({ success: false, error: 'Wallet mismatch' });
      return;
    }

    // Step 1: Prepare close transaction
    const closeResult = await prepareClosePositionTransaction({
      positionId,
      walletAddress,
    });

    // Step 2: Prepare new position in same pool at current price
    const ranked = await analyzeAndRankPools(10);
    const pool = ranked.find(p => p.address === position.poolAddress) || ranked[0];

    if (!pool) {
      res.status(404).json({ success: false, error: 'No suitable pool found for rebalance' });
      return;
    }

    // Build rebalance context so the strategy optimizer can learn from the previous position
    const rebalanceCtx = {
      prevMinBinId: position.minBinId,
      prevMaxBinId: position.maxBinId,
      prevCreatedAt: position.createdAt,
      rebalanceCount: position.rebalanceCount,
    };

    const newPosition = await preparePositionTransaction({
      pool,
      solAmount: position.solDeposited,
      walletAddress,
      isRebalance: true,
      rebalanceCtx,
    });

    res.json({
      success: true,
      data: {
        closeTxs: closeResult.serializedTxs,
        closeTxBlockhash: closeResult.blockhash,
        closeTxLastValidBlockHeight: closeResult.lastValidBlockHeight,
        newPositionTx: newPosition.serializedTx,
        newPositionPubkey: newPosition.positionPubkey,
        newPositionStrategy: newPosition.strategy,
        newPositionBlockhash: newPosition.blockhash,
        newPositionLastValidBlockHeight: newPosition.lastValidBlockHeight,
        poolAddress: pool.address,
        poolName: pool.name,
        switchedPool: pool.address !== position.poolAddress,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/positions/:id/rebalance-confirm
 * After user signs both close + new position txs, update DB accordingly.
 *
 * Body: { walletAddress, newPositionPubkey, poolAddress, poolName, strategy, solDeposited }
 */
positionsRouter.post('/:id/rebalance-confirm', async (req: Request, res: Response) => {
  try {
    const positionId = req.params.id;
    const { walletAddress, newPositionPubkey, poolAddress, poolName, strategy, solDeposited } = req.body;

    if (!walletAddress || !newPositionPubkey) {
      res.status(400).json({ success: false, error: 'walletAddress and newPositionPubkey are required' });
      return;
    }

    // Close old position
    await confirmClosePosition({ positionId, walletAddress });

    // Record new position
    await confirmPosition({
      walletAddress,
      poolAddress,
      poolName,
      positionPubkey: newPositionPubkey,
      solDeposited: solDeposited || 0,
      strategy,
      mode: 'assisted' as AgentMode,
    });

    // Create notification about successful rebalance
    await createNotification({
      walletAddress,
      type: 'rebalance_needed',
      title: 'Rebalance completed',
      message: `Position in ${poolName} has been rebalanced to the current price range.`,
      positionId,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/positions/:id/swap-to-sol
 * After closing/withdrawing a position, swap any remaining non-SOL tokens to SOL.
 * Returns a serialized Jupiter swap transaction for the frontend to sign.
 *
 * Body: { walletAddress: string }
 */
positionsRouter.post('/:id/swap-to-sol', async (req: Request, res: Response) => {
  try {
    const positionId = req.params.id;
    const { walletAddress } = req.body;

    if (!walletAddress) {
      res.status(400).json({ success: false, error: 'walletAddress is required' });
      return;
    }

    const position = await prisma.position.findUnique({
      where: { id: positionId },
    });
    if (!position) {
      res.status(404).json({ success: false, error: 'Position not found' });
      return;
    }

    // Determine the non-SOL token mint from the pool data
    const meteora = getMeteoraService();
    const pool = await meteora.getPool(position.poolAddress);
    const mintX = pool.tokenX.publicKey.toBase58();
    const mintY = pool.tokenY.publicKey.toBase58();
    const nonSolMint = getNonSolMint(mintX, mintY);

    // Prepare Jupiter swap to convert non-SOL token → SOL
    const swapResult = await prepareSwapToSol({
      walletAddress,
      tokenMint: nonSolMint,
    });

    if (!swapResult) {
      res.json({
        success: true,
        data: { noSwapNeeded: true, message: 'No non-SOL tokens to swap' },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        serializedTx: swapResult.serializedTx,
        tokenMint: nonSolMint,
        inputAmount: swapResult.inputAmount,
        expectedOutputSol: swapResult.expectedOutputSol,
      },
    });
  } catch (err) {
    logger.error('Swap-to-SOL failed', { error: (err as Error).message });
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
