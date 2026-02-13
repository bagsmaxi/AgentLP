import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { prisma } from '../db';
import { config } from '../config';
import { getSolPrice } from './price-feed';
import { logger } from '../utils/logger';

const TREASURY_PUBKEY = new PublicKey(config.fees.treasuryWallet);

/**
 * Calculate deposit fee in SOL ($0.50 USD worth).
 */
export async function getDepositFeeSol(): Promise<number> {
  const solPrice = await getSolPrice();
  if (!solPrice || solPrice <= 0) {
    // Fallback: ~$0.50 at ~$150/SOL
    return 0.0033;
  }
  return config.fees.depositFeeUsd / solPrice;
}

/**
 * Create a SOL transfer instruction for the deposit fee.
 * Returns the instruction to include in the deposit transaction.
 */
export function createFeeTransferInstruction(
  fromPubkey: PublicKey,
  feeLamports: number
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey,
    toPubkey: TREASURY_PUBKEY,
    lamports: feeLamports,
  });
}

/**
 * Record a fee payment in the database.
 */
export async function recordFee(params: {
  walletAddress: string;
  positionId?: string;
  type: 'deposit' | 'performance';
  amountSol: number;
  amountUsd: number;
  txSignature?: string;
}): Promise<void> {
  try {
    await prisma.feeRecord.create({
      data: {
        walletAddress: params.walletAddress,
        positionId: params.positionId,
        type: params.type,
        amountSol: params.amountSol,
        amountUsd: params.amountUsd,
        txSignature: params.txSignature,
      },
    });
    logger.info('Fee recorded', { type: params.type, amountSol: params.amountSol });
  } catch (err) {
    logger.error('Failed to record fee', { error: (err as Error).message });
  }
}

/**
 * Calculate performance fee on earned fees.
 * Returns the fee amount in SOL.
 */
export function calculatePerformanceFee(earnedSol: number): number {
  return earnedSol * (config.fees.performanceFeePercent / 100);
}
