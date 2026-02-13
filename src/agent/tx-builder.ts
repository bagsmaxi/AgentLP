import { Keypair, PublicKey } from '@solana/web3.js';
import { ScoredPool, StrategyConfig, PreparedTransaction, CreatePositionRequest, AgentMode } from '../types';
import { getMeteoraService } from '../services/meteora';
import { loadKeypair, solToLamports } from '../services/solana';
import { getDepositFeeSol, createFeeTransferInstruction, recordFee } from '../services/fees';
import { getSolPrice } from '../services/price-feed';
import { optimizeStrategy, RebalanceContext } from './strategy-optimizer';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Full pipeline: pick strategy, build transaction, execute or serialize.
 *
 * For keypair mode: signs and sends, returns signature.
 * For wallet adapter mode: returns serialized transaction for client to sign.
 */
export async function buildAndExecutePosition(params: {
  pool: ScoredPool;
  solAmount: number;
  walletAddress: string;
  keypairPath?: string;
  mode: AgentMode;
  sessionId?: string;
}): Promise<{
  positionPubkey: string;
  strategy: StrategyConfig;
  signature?: string;
  serializedTx?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
}> {
  const { pool, solAmount, walletAddress, keypairPath, mode, sessionId } = params;

  // 1. Optimize strategy (determines bin range + strategy type)
  const strategy = await optimizeStrategy(pool);

  // 2. Load keypair if provided (auto-sign mode)
  const keypair = keypairPath ? loadKeypair(keypairPath) : null;
  const userPubkey = new PublicKey(walletAddress);

  // 3. Load the DLMM pool
  const meteora = getMeteoraService();
  const dlmmPool = await meteora.getPool(pool.address);

  // 4. Calculate deposit fee
  const depositFeeSol = await getDepositFeeSol();
  const feeLamports = solToLamports(depositFeeSol);
  const feeInstruction = createFeeTransferInstruction(userPubkey, feeLamports);

  // 5. Create the position with fee instruction
  const solAmountLamports = solToLamports(solAmount);
  const result = await meteora.createPosition({
    pool: dlmmPool,
    solAmountLamports,
    solSide: pool.solSide,
    strategy,
    userPubkey,
    keypair: keypair || undefined,
    extraInstructions: [feeInstruction],
  });

  logger.info('Position built', {
    pool: pool.name,
    positionPubkey: result.positionPubkey,
    strategy: strategy.strategyType,
    mode: keypair ? 'auto-sign' : 'wallet-adapter',
  });

  // 6. Record deposit fee
  if (result.signature) {
    const solPrice = await getSolPrice();
    await recordFee({
      walletAddress,
      type: 'deposit',
      amountSol: depositFeeSol,
      amountUsd: depositFeeSol * (solPrice || 0),
      txSignature: result.signature,
    });
  }

  // 7. Record position in DB (only if we have a confirmed signature)
  if (result.signature) {
    await prisma.position.create({
      data: {
        walletAddress,
        poolAddress: pool.address,
        poolName: pool.name,
        positionPubkey: result.positionPubkey,
        mode,
        solDeposited: solAmount,
        strategy: strategy.strategyType,
        minBinId: strategy.minBinId,
        maxBinId: strategy.maxBinId,
        status: 'active',
        sessionId,
      },
    });
    logger.info('Position saved to DB', { positionPubkey: result.positionPubkey });
  }

  return {
    positionPubkey: result.positionPubkey,
    strategy,
    signature: result.signature,
    serializedTx: result.serializedTx,
    blockhash: result.blockhash,
    lastValidBlockHeight: result.lastValidBlockHeight,
  };
}

/**
 * Prepare a transaction without executing (for wallet adapter mode).
 * Returns the serialized transaction for the frontend to submit to user's wallet.
 */
export async function preparePositionTransaction(params: {
  pool: ScoredPool;
  solAmount: number;
  walletAddress: string;
  isRebalance?: boolean;
  rebalanceCtx?: RebalanceContext;
}): Promise<PreparedTransaction & { depositFeeSol?: number }> {
  const { pool, solAmount, walletAddress, isRebalance = false, rebalanceCtx } = params;

  const strategy = await optimizeStrategy(pool, rebalanceCtx);
  const userPubkey = new PublicKey(walletAddress);
  const meteora = getMeteoraService();
  const dlmmPool = await meteora.getPool(pool.address);
  const solAmountLamports = solToLamports(solAmount);

  // Skip deposit fee on rebalance — user already paid it on the initial deposit
  const extraInstructions = [];
  let depositFeeSol = 0;
  if (!isRebalance) {
    depositFeeSol = await getDepositFeeSol();
    const feeLamports = solToLamports(depositFeeSol);
    const feeInstruction = createFeeTransferInstruction(userPubkey, feeLamports);
    extraInstructions.push(feeInstruction);
  }

  const result = await meteora.createPosition({
    pool: dlmmPool,
    solAmountLamports,
    solSide: pool.solSide,
    strategy,
    userPubkey,
    extraInstructions,
    skipSimulation: isRebalance,
  });

  if (!result.serializedTx) {
    throw new Error('Failed to serialize transaction');
  }

  // Record the fee (skip for rebalance)
  if (!isRebalance && depositFeeSol > 0) {
    const solPrice = await getSolPrice();
    await recordFee({
      walletAddress,
      type: 'deposit',
      amountSol: depositFeeSol,
      amountUsd: depositFeeSol * (solPrice || 0),
    });

    logger.info('Deposit fee included in transaction', {
      feeSol: depositFeeSol.toFixed(6),
      feeUsd: config.fees.depositFeeUsd,
    });
  }

  return {
    serializedTx: result.serializedTx,
    positionPubkey: result.positionPubkey,
    poolAddress: pool.address,
    strategy,
    blockhash: result.blockhash,
    lastValidBlockHeight: result.lastValidBlockHeight,
    depositFeeSol,
  };
}

/**
 * Record a position after client-side signing confirms the transaction.
 * Called by the frontend after the user signs and the tx is confirmed.
 */
export async function confirmPosition(params: {
  walletAddress: string;
  poolAddress: string;
  poolName: string;
  positionPubkey: string;
  solDeposited: number;
  strategy: StrategyConfig;
  mode: AgentMode;
  sessionId?: string;
  pairedTokenMint?: string;
}): Promise<void> {
  await prisma.position.create({
    data: {
      walletAddress: params.walletAddress,
      poolAddress: params.poolAddress,
      poolName: params.poolName,
      pairedTokenMint: params.pairedTokenMint,
      positionPubkey: params.positionPubkey,
      mode: params.mode,
      solDeposited: params.solDeposited,
      strategy: params.strategy.strategyType,
      minBinId: params.strategy.minBinId,
      maxBinId: params.strategy.maxBinId,
      status: 'active',
      sessionId: params.sessionId,
    },
  });
  logger.info('Position confirmed and saved', { positionPubkey: params.positionPubkey });
}

/**
 * Prepare transaction(s) to close a position: remove all liquidity + claim fees + close account.
 * Returns serialized transaction(s) for the frontend to sign.
 */
export async function prepareClosePositionTransaction(params: {
  positionId: string;
  walletAddress: string;
}): Promise<{
  serializedTxs: string[];
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const { positionId, walletAddress } = params;

  const position = await prisma.position.findUnique({
    where: { id: positionId },
  });
  if (!position) throw new Error('Position not found');
  if (position.status !== 'active') throw new Error('Position is not active');
  if (position.walletAddress !== walletAddress) throw new Error('Wallet mismatch');

  const meteora = getMeteoraService();
  const pool = await meteora.getPool(position.poolAddress);
  const userPubkey = new PublicKey(walletAddress);
  const positionPubkey = new PublicKey(position.positionPubkey);

  logger.info('Preparing close position transaction', {
    positionId,
    pool: position.poolName,
    positionPubkey: position.positionPubkey,
  });

  const result = await meteora.removeLiquidity({
    pool,
    userPubkey,
    positionPubkey,
    minBinId: position.minBinId,
    maxBinId: position.maxBinId,
    shouldClaimAndClose: true,
  });

  if (!result.serializedTx) {
    throw new Error('Failed to build close transaction');
  }

  const serializedTxs = result.serializedTx.split('|');

  return {
    serializedTxs,
    blockhash: result.blockhash!,
    lastValidBlockHeight: result.lastValidBlockHeight!,
  };
}

/**
 * Mark a position as closed in the DB after the user has signed and confirmed the close tx.
 */
export async function confirmClosePosition(params: {
  positionId: string;
  walletAddress: string;
}): Promise<void> {
  const { positionId, walletAddress } = params;

  const position = await prisma.position.findUnique({
    where: { id: positionId },
  });
  if (!position) throw new Error('Position not found');
  if (position.walletAddress !== walletAddress) throw new Error('Wallet mismatch');

  // Record performance fee if fees were earned
  if (position.totalFeesEarned > 0) {
    const { calculatePerformanceFee } = await import('../services/fees');
    const perfFee = calculatePerformanceFee(position.totalFeesEarned);
    if (perfFee > 0) {
      const solPrice = await getSolPrice();
      await recordFee({
        walletAddress,
        positionId,
        type: 'performance',
        amountSol: perfFee,
        amountUsd: perfFee * (solPrice || 0),
      });
      logger.info('Performance fee recorded', { positionId, feeSol: perfFee });
    }
  }

  await prisma.position.update({
    where: { id: positionId },
    data: {
      status: 'closed',
      closedAt: new Date(),
    },
  });

  logger.info('Position closed', { positionId, positionPubkey: position.positionPubkey });
}
