import { PublicKey } from '@solana/web3.js';
import { prisma } from '../db';
import { getMeteoraService } from '../services/meteora';
import { loadKeypair } from '../services/solana';
import { broadcastUpdate } from '../server';
import { config } from '../config';
import { logger } from '../utils/logger';

interface PositionRecord {
  id: string;
  walletAddress: string;
  poolAddress: string;
  poolName: string;
  positionPubkey: string;
}

/**
 * Claim fees for a position if accumulated fees exceed threshold.
 * Uses positionBinData fee amounts (the actual claimable fees) instead of
 * the raw positionData.feeX/feeY checkpoint values.
 */
export async function claimFeesIfThreshold(
  position: PositionRecord,
  keypairPath: string
): Promise<void> {
  try {
    const keypair = loadKeypair(keypairPath);
    if (!keypair) {
      logger.error('Cannot claim fees: keypair not available');
      return;
    }

    const meteora = getMeteoraService();
    const pool = await meteora.getPool(position.poolAddress);
    const ownerPubkey = new PublicKey(position.walletAddress);

    // Get actual claimable fees from positionBinData
    const positionFees = await meteora.getClaimableFees(pool, ownerPubkey);
    const totalFeeSol = positionFees.get(position.positionPubkey) || 0;

    if (totalFeeSol < config.monitoring.feeClaimThresholdSol) {
      return; // Not enough to justify claiming
    }

    logger.info('Claiming fees', {
      position: position.positionPubkey,
      pool: position.poolName,
      feeSol: totalFeeSol.toFixed(6),
    });

    const result = await meteora.claimAllRewards({
      pool,
      ownerPubkey,
      keypair,
    });

    if (result.signature) {
      // Update DB with earned fees
      await prisma.position.update({
        where: { id: position.id },
        data: {
          totalFeesEarned: { increment: totalFeeSol },
        },
      });

      broadcastUpdate(position.walletAddress, 'fees_claimed', {
        positionPubkey: position.positionPubkey,
        poolName: position.poolName,
        feesClaimedSol: totalFeeSol,
        signature: result.signature,
      });

      logger.info('Fees claimed successfully', {
        position: position.positionPubkey,
        feeSol: totalFeeSol.toFixed(6),
        signature: result.signature,
      });
    }
  } catch (err) {
    logger.error('Failed to claim fees', {
      position: position.positionPubkey,
      error: err,
    });
  }
}
