import { PublicKey } from '@solana/web3.js';
import { prisma } from '../db';
import { getMeteoraService } from '../services/meteora';
import { loadKeypair } from '../services/solana';
import { broadcastUpdate } from '../server';
import { createNotification } from '../routes/notifications';
import { logger } from '../utils/logger';
import { config } from '../config';

// Active monitoring loops per wallet
const monitoringIntervals = new Map<string, NodeJS.Timeout>();

/**
 * Start monitoring all active positions for a wallet.
 * Runs on an interval defined in config.
 */
export function startMonitoring(walletAddress: string, keypairPath?: string) {
  if (monitoringIntervals.has(walletAddress)) {
    logger.info('Monitoring already active', { wallet: walletAddress });
    return;
  }

  logger.info('Starting position monitoring', {
    wallet: walletAddress,
    intervalMs: config.monitoring.intervalMs,
  });

  // Run immediately, then on interval
  checkPositions(walletAddress, keypairPath);

  const interval = setInterval(
    () => checkPositions(walletAddress, keypairPath),
    config.monitoring.intervalMs
  );

  monitoringIntervals.set(walletAddress, interval);
}

/**
 * Stop monitoring for a wallet.
 */
export function stopMonitoring(walletAddress: string) {
  const interval = monitoringIntervals.get(walletAddress);
  if (interval) {
    clearInterval(interval);
    monitoringIntervals.delete(walletAddress);
    logger.info('Monitoring stopped', { wallet: walletAddress });
  }
}

/**
 * Check all active positions for a wallet.
 * - Detects out-of-range positions
 * - Triggers fee claiming when threshold is met
 * - Triggers rebalancing for auto-mode positions
 */
async function checkPositions(walletAddress: string, keypairPath?: string) {
  try {
    const positions = await prisma.position.findMany({
      where: {
        walletAddress,
        status: 'active',
      },
    });

    if (positions.length === 0) return;

    const meteora = getMeteoraService();

    for (const position of positions) {
      try {
        const pool = await meteora.getPool(position.poolAddress);
        const { inRange, activeBinId } = await meteora.isPositionInRange(
          pool,
          position.minBinId,
          position.maxBinId
        );

        // Broadcast status update via WebSocket
        broadcastUpdate(walletAddress, 'position_check', {
          positionPubkey: position.positionPubkey,
          poolName: position.poolName,
          activeBinId,
          minBinId: position.minBinId,
          maxBinId: position.maxBinId,
          inRange,
        });

        if (!inRange) {
          logger.warn('Position out of range!', {
            position: position.positionPubkey,
            pool: position.poolName,
            activeBin: activeBinId,
            range: `${position.minBinId}-${position.maxBinId}`,
          });

          broadcastUpdate(walletAddress, 'position_out_of_range', {
            positionPubkey: position.positionPubkey,
            poolName: position.poolName,
            activeBinId,
          });

          // If auto mode + keypair available, trigger rebalance
          if (position.mode === 'auto' && keypairPath && config.monitoring.rebalanceEnabled) {
            const { rebalancePosition } = await import('./rebalancer');
            await rebalancePosition(position, keypairPath);
          } else {
            // Wallet adapter mode: create notification for user to rebalance manually
            // Avoid duplicate notifications: check if one was already created in last 30 min
            const recentNotif = await prisma.notification.findFirst({
              where: {
                walletAddress,
                positionId: position.id,
                type: 'out_of_range',
                createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
              },
            });

            if (!recentNotif) {
              await createNotification({
                walletAddress,
                type: 'out_of_range',
                title: `${position.poolName} out of range`,
                message: `Your position in ${position.poolName} is out of range (active bin: ${activeBinId}, your range: ${position.minBinId}-${position.maxBinId}). Consider rebalancing or withdrawing.`,
                positionId: position.id,
                actionType: 'rebalance',
              });
            }
          }
        }

        // Check and claim fees if above threshold
        if (keypairPath) {
          const { claimFeesIfThreshold } = await import('./fee-claimer');
          await claimFeesIfThreshold(position, keypairPath);
        }
      } catch (err) {
        logger.error('Error checking position', {
          position: position.positionPubkey,
          error: err,
        });
      }
    }
  } catch (err) {
    logger.error('Error in monitoring loop', { wallet: walletAddress, error: err });
  }
}

/**
 * Get monitoring status for a wallet.
 */
export function isMonitoring(walletAddress: string): boolean {
  return monitoringIntervals.has(walletAddress);
}
