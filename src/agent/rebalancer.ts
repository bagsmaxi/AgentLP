import { PublicKey } from '@solana/web3.js';
import { prisma } from '../db';
import { getMeteoraService } from '../services/meteora';
import { loadKeypair, solToLamports } from '../services/solana';
import { getSolPrice } from '../services/price-feed';
import { analyzeAndRankPools } from './pool-analyzer';
import { optimizeStrategy } from './strategy-optimizer';
import { broadcastUpdate } from '../server';
import { logger } from '../utils/logger';

interface PositionRecord {
  id: string;
  walletAddress: string;
  poolAddress: string;
  poolName: string;
  positionPubkey: string;
  solDeposited: number;
  strategy: string;
  minBinId: number;
  maxBinId: number;
  mode: string;
  sessionId: string | null;
  createdAt: Date;
  rebalanceCount: number;
}

/**
 * Rebalance an out-of-range position:
 * 1. Remove all liquidity + claim fees
 * 2. Check if current pool is still the best
 * 3. If yes: create new position at updated range
 * 4. If no: switch to a better pool
 */
export async function rebalancePosition(
  position: PositionRecord,
  keypairPath: string
): Promise<void> {
  const keypair = loadKeypair(keypairPath);
  if (!keypair) {
    logger.error('Cannot rebalance: keypair not available');
    return;
  }

  const meteora = getMeteoraService();
  const ownerPubkey = new PublicKey(position.walletAddress);
  const positionPubkey = new PublicKey(position.positionPubkey);

  try {
    // Mark position as rebalancing
    await prisma.position.update({
      where: { id: position.id },
      data: { status: 'rebalancing' },
    });

    broadcastUpdate(position.walletAddress, 'rebalance_started', {
      positionPubkey: position.positionPubkey,
      poolName: position.poolName,
    });

    // Step 1: Remove all liquidity and claim
    logger.info('Rebalancing: removing liquidity', {
      position: position.positionPubkey,
    });

    const pool = await meteora.getPool(position.poolAddress);
    await meteora.removeLiquidity({
      pool,
      userPubkey: ownerPubkey,
      positionPubkey,
      minBinId: position.minBinId,
      maxBinId: position.maxBinId,
      keypair,
      shouldClaimAndClose: true,
    });

    // Log performance data for learning
    const solPrice = await getSolPrice();
    await prisma.performanceLog.create({
      data: {
        positionId: position.id,
        poolAddress: position.poolAddress,
        strategy: position.strategy,
        binWidth: position.maxBinId - position.minBinId,
        feesEarned: 0, // Will be updated when we can calculate exact fees
        duration: Math.floor((Date.now() - new Date(position.positionPubkey).getTime()) / 1000) || 3600,
        solPrice,
        outcome: 'breakeven', // Will be refined by learning engine
      },
    });

    // Step 2: Check if current pool is still the best
    const rankedPools = await analyzeAndRankPools(5);
    const currentPoolRanked = rankedPools.find(p => p.address === position.poolAddress);
    const bestPool = rankedPools[0];

    // Use current pool if still top 3, otherwise switch
    const targetPool =
      currentPoolRanked && rankedPools.indexOf(currentPoolRanked) < 3
        ? currentPoolRanked
        : bestPool;

    if (!targetPool) {
      logger.warn('No suitable pool for rebalancing');
      await prisma.position.update({
        where: { id: position.id },
        data: { status: 'closed', closedAt: new Date() },
      });
      return;
    }

    const switchedPool = targetPool.address !== position.poolAddress;
    if (switchedPool) {
      logger.info('Rebalancing: switching pools', {
        from: position.poolName,
        to: targetPool.name,
      });
    }

    // Step 3: Create new position at optimal range (with rebalance context for smarter widening)
    const strategy = await optimizeStrategy(targetPool, {
      prevMinBinId: position.minBinId,
      prevMaxBinId: position.maxBinId,
      prevCreatedAt: position.createdAt,
      rebalanceCount: position.rebalanceCount,
    });
    const newPool = await meteora.getPool(targetPool.address);
    const solAmountLamports = solToLamports(position.solDeposited);

    const result = await meteora.createPosition({
      pool: newPool,
      solAmountLamports,
      solSide: targetPool.solSide,
      strategy,
      userPubkey: ownerPubkey,
      keypair,
    });

    // Close old position record, create new one
    await prisma.position.update({
      where: { id: position.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        rebalanceCount: { increment: 1 },
      },
    });

    if (result.signature) {
      await prisma.position.create({
        data: {
          walletAddress: position.walletAddress,
          poolAddress: targetPool.address,
          poolName: targetPool.name,
          positionPubkey: result.positionPubkey,
          mode: position.mode,
          solDeposited: position.solDeposited,
          strategy: strategy.strategyType,
          minBinId: strategy.minBinId,
          maxBinId: strategy.maxBinId,
          status: 'active',
          sessionId: position.sessionId,
          rebalanceCount: position.mode === 'auto' ? 1 : 0,
        },
      });
    }

    broadcastUpdate(position.walletAddress, 'rebalance_completed', {
      oldPosition: position.positionPubkey,
      newPosition: result.positionPubkey,
      poolName: targetPool.name,
      strategy: strategy.strategyType,
      switchedPool,
      signature: result.signature,
    });

    logger.info('Rebalance completed', {
      oldPosition: position.positionPubkey,
      newPosition: result.positionPubkey,
      pool: targetPool.name,
      strategy: strategy.strategyType,
    });
  } catch (err) {
    logger.error('Rebalance failed', {
      position: position.positionPubkey,
      error: err,
    });

    // Revert status
    await prisma.position.update({
      where: { id: position.id },
      data: { status: 'active' },
    });

    broadcastUpdate(position.walletAddress, 'rebalance_failed', {
      positionPubkey: position.positionPubkey,
      error: (err as Error).message,
    });
  }
}
