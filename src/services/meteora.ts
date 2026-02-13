import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { getConnection, signAndSendTransaction, serializeTransaction, solToLamports } from './solana';
import { StrategyConfig, StrategyName } from '../types';
import { logger } from '../utils/logger';

// DLMM SDK constants
const SINGLE_TX_BIN_LIMIT = 69;  // Max bins for single-tx init (DEFAULT_BIN_PER_POSITION - 1)
const MAX_RESIZE_PER_IX = 91;     // MAX_RESIZE_LENGTH from SDK

// Map our strategy names to DLMM SDK numeric StrategyType enum (Spot=0, Curve=1, BidAsk=2)
const STRATEGY_TYPE_MAP: Record<StrategyName, StrategyType> = {
  Spot: StrategyType.Spot,
  Curve: StrategyType.Curve,
  BidAsk: StrategyType.BidAsk,
};

export class MeteoraService {
  private connection: Connection;

  constructor() {
    this.connection = getConnection();
  }

  /**
   * Create a DLMM pool instance from a pool address
   */
  async getPool(poolAddress: string): Promise<DLMM> {
    const pubkey = new PublicKey(poolAddress);
    const pool = await DLMM.create(this.connection, pubkey);
    logger.info('DLMM pool loaded', { address: poolAddress });
    return pool;
  }

  /**
   * Get the current active bin for a pool
   */
  async getActiveBin(pool: DLMM) {
    const activeBin = await pool.getActiveBin();
    return activeBin;
  }

  /**
   * Get bins around the active bin for analysis
   */
  async getBinsAroundActive(pool: DLMM, leftCount: number = 30, rightCount: number = 30) {
    return pool.getBinsAroundActiveBin(leftCount, rightCount);
  }

  /**
   * Get all positions for a user in a specific pool
   */
  async getUserPositions(pool: DLMM, userPubkey: PublicKey) {
    return pool.getPositionsByUserAndLbPair(userPubkey);
  }

  /**
   * Get fee info for a pool
   */
  getFeeInfo(pool: DLMM) {
    return pool.getFeeInfo();
  }

  /**
   * Create a new single-sided SOL LP position.
   *
   * For single-sided:
   * - If SOL is tokenX: totalXAmount = deposit, totalYAmount = 0
   * - If SOL is tokenY: totalYAmount = deposit, totalXAmount = 0
   *
   * Returns either a signature (keypair mode) or serialized tx (wallet adapter mode)
   */
  async createPosition(params: {
    pool: DLMM;
    solAmountLamports: number;
    solSide: 'X' | 'Y';
    strategy: StrategyConfig;
    userPubkey: PublicKey;
    keypair?: Keypair;
    slippage?: number;
    extraInstructions?: TransactionInstruction[];
    skipSimulation?: boolean;
  }): Promise<{
    signature?: string;
    serializedTx?: string;
    serializedTxs?: string[];
    positionPubkey: string;
    blockhash?: string;
    lastValidBlockHeight?: number;
  }> {
    const {
      pool,
      solAmountLamports,
      solSide,
      strategy,
      userPubkey,
      keypair,
      slippage = 100,
      extraInstructions = [],
      skipSimulation = false,
    } = params;

    const binCount = strategy.maxBinId - strategy.minBinId + 1;

    logger.info('Creating position', {
      pool: pool.pubkey.toBase58(),
      solAmount: solAmountLamports,
      solSide,
      strategy: strategy.strategyType,
      binRange: `${strategy.minBinId} - ${strategy.maxBinId}`,
      binCount,
      widePosition: binCount > SINGLE_TX_BIN_LIMIT,
    });

    // Wide positions (>69 bins) need multi-step: init → resize → addLiquidity
    if (binCount > SINGLE_TX_BIN_LIMIT) {
      return this.createWidePosition({
        pool,
        solAmountLamports,
        solSide,
        strategy,
        userPubkey,
        slippage,
        extraInstructions,
      });
    }

    // Standard single-tx path for positions ≤ 69 bins
    const positionKeypair = Keypair.generate();
    const positionPubkey = positionKeypair.publicKey;

    const totalXAmount = solSide === 'X' ? new BN(solAmountLamports) : new BN(0);
    const totalYAmount = solSide === 'Y' ? new BN(solAmountLamports) : new BN(0);
    const isSingleSidedX = solSide === 'X';

    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionPubkey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId: strategy.minBinId,
        maxBinId: strategy.maxBinId,
        strategyType: STRATEGY_TYPE_MAP[strategy.strategyType],
        singleSidedX: isSingleSidedX,
      },
      user: userPubkey,
      slippage,
    });

    const conn = getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

    if (tx instanceof Transaction && extraInstructions.length > 0) {
      for (const ix of extraInstructions) {
        tx.add(ix);
      }
    }

    if (keypair) {
      if (tx instanceof Transaction) {
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = keypair.publicKey;
        tx.partialSign(positionKeypair);

        const signature = await signAndSendTransaction(tx, keypair);
        return { signature, positionPubkey: positionPubkey.toBase58() };
      }
    }

    if (tx instanceof Transaction) {
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = userPubkey;
      tx.partialSign(positionKeypair);

      if (!skipSimulation) {
        try {
          const simulation = await conn.simulateTransaction(tx);
          if (simulation.value.err) {
            const errStr = JSON.stringify(simulation.value.err);
            if (errStr.includes('"Custom":1') || errStr.includes('insufficient lamports')) {
              throw new Error(
                'Insufficient SOL balance for this transaction. ' +
                'You need enough SOL for the deposit plus ~0.05 SOL for position account rent, token accounts, and fees. ' +
                'Try a smaller deposit amount.'
              );
            }
            throw new Error(`Transaction simulation failed: ${errStr}`);
          }
        } catch (simErr: any) {
          if (simErr.message.includes('Insufficient SOL') || simErr.message.includes('simulation failed')) {
            throw simErr;
          }
          logger.warn('Simulation check skipped (non-critical)', { error: simErr.message });
        }
      }

      const serialized = serializeTransaction(tx);
      return {
        serializedTx: serialized,
        positionPubkey: positionPubkey.toBase58(),
        blockhash,
        lastValidBlockHeight,
      };
    }

    throw new Error('Unexpected transaction format from DLMM SDK');
  }

  /**
   * Create a wide position (>69 bins) using multi-step approach.
   *
   * Solana's 10KB-per-instruction realloc limit means positions can only be
   * initialized with ~69 bins in a single instruction. For wider positions:
   *   1. Transaction 1: Initialize position with 69 bins
   *   2. Transaction 2+: Resize position in chunks of 91 bins (MAX_RESIZE_LENGTH)
   *   3. Final Transaction: Add liquidity to the full range via addLiquidityByStrategy
   *
   * All transactions are built upfront and returned as serializedTxs array.
   * The frontend signs and confirms them sequentially.
   */
  private async createWidePosition(params: {
    pool: DLMM;
    solAmountLamports: number;
    solSide: 'X' | 'Y';
    strategy: StrategyConfig;
    userPubkey: PublicKey;
    slippage: number;
    extraInstructions: TransactionInstruction[];
  }): Promise<{
    serializedTxs: string[];
    positionPubkey: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const { pool, solAmountLamports, solSide, strategy, userPubkey, slippage, extraInstructions } = params;

    const positionKeypair = Keypair.generate();
    const positionPubkey = positionKeypair.publicKey;
    const binCount = strategy.maxBinId - strategy.minBinId + 1;
    const isSingleSidedX = solSide === 'X';

    // Determine init range (69 bins from the starting end of our range)
    // For SOL X (bins above active): init lower portion, resize upper
    // For SOL Y (bins below active): init upper portion, resize lower
    const initWidth = SINGLE_TX_BIN_LIMIT;
    let initMinBinId: number;
    let resizeSide: number; // 0=lower (extend down), 1=upper (extend up)

    if (solSide === 'X') {
      initMinBinId = strategy.minBinId;
      resizeSide = 1; // extend upper to reach strategy.maxBinId
    } else {
      initMinBinId = strategy.maxBinId - initWidth + 1;
      resizeSide = 0; // extend lower to reach strategy.minBinId
    }

    const conn = getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const transactions: Transaction[] = [];

    // ── Transaction 1: Initialize position with 69 bins ──
    // Uses the SDK's combined init+addLiquidity but with 0 amounts (just create the position)
    // This handles bin array initialization for the initial range
    const initTx = new Transaction();

    // Set compute budget for init
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

    // Build initializePosition instruction via the pool's program
    const initIx = await (pool as any).program.methods
      .initializePosition(initMinBinId, initWidth)
      .accountsPartial({
        payer: userPubkey,
        position: positionPubkey,
        lbPair: pool.pubkey,
        owner: userPubkey,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    initTx.add(initIx);

    // Add extra instructions (e.g., deposit fee transfer) to the init tx
    for (const ix of extraInstructions) {
      initTx.add(ix);
    }

    initTx.recentBlockhash = blockhash;
    initTx.lastValidBlockHeight = lastValidBlockHeight;
    initTx.feePayer = userPubkey;
    initTx.partialSign(positionKeypair);
    transactions.push(initTx);

    // ── Transaction(s) 2+: Resize position to full width ──
    const extraBins = binCount - initWidth;
    if (extraBins > 0) {
      let remaining = extraBins;
      while (remaining > 0) {
        const chunk = Math.min(remaining, MAX_RESIZE_PER_IX);

        const resizeTx = new Transaction();
        resizeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));

        const resizeIx = await (pool as any).program.methods
          .increasePositionLength(chunk, resizeSide)
          .accountsPartial({
            lbPair: pool.pubkey,
            position: positionPubkey,
            owner: userPubkey,
            funder: userPubkey,
          })
          .instruction();
        resizeTx.add(resizeIx);

        resizeTx.recentBlockhash = blockhash;
        resizeTx.lastValidBlockHeight = lastValidBlockHeight;
        resizeTx.feePayer = userPubkey;
        transactions.push(resizeTx);

        remaining -= chunk;
      }
    }

    // ── Final Transaction: Add liquidity to full range ──
    const totalXAmount = solSide === 'X' ? new BN(solAmountLamports) : new BN(0);
    const totalYAmount = solSide === 'Y' ? new BN(solAmountLamports) : new BN(0);

    const addLiqTx = await pool.addLiquidityByStrategy({
      positionPubKey: positionPubkey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId: strategy.minBinId,
        maxBinId: strategy.maxBinId,
        strategyType: STRATEGY_TYPE_MAP[strategy.strategyType],
        singleSidedX: isSingleSidedX,
      },
      user: userPubkey,
      slippage,
    });

    if (addLiqTx instanceof Transaction) {
      addLiqTx.recentBlockhash = blockhash;
      addLiqTx.lastValidBlockHeight = lastValidBlockHeight;
      addLiqTx.feePayer = userPubkey;
      transactions.push(addLiqTx);
    }

    // Serialize all transactions
    const serializedTxs = transactions.map(tx => serializeTransaction(tx));

    logger.info('Wide position built', {
      pool: pool.pubkey.toBase58(),
      binCount,
      initWidth,
      resizeSteps: Math.ceil(extraBins / MAX_RESIZE_PER_IX),
      totalTransactions: transactions.length,
      positionPubkey: positionPubkey.toBase58(),
    });

    return {
      serializedTxs,
      positionPubkey: positionPubkey.toBase58(),
      blockhash,
      lastValidBlockHeight,
    };
  }

  /**
   * Remove all liquidity from a position.
   * If the position has no liquidity (empty bins), falls back to closePositionIfEmpty
   * to reclaim the rent SOL.
   */
  async removeLiquidity(params: {
    pool: DLMM;
    userPubkey: PublicKey;
    positionPubkey: PublicKey;
    minBinId: number;
    maxBinId: number;
    keypair?: Keypair;
    shouldClaimAndClose?: boolean;
  }): Promise<{ signature?: string; serializedTx?: string; blockhash?: string; lastValidBlockHeight?: number }> {
    const {
      pool,
      userPubkey,
      positionPubkey,
      minBinId,
      maxBinId,
      keypair,
      shouldClaimAndClose = true,
    } = params;

    logger.info('Removing liquidity', {
      position: positionPubkey.toBase58(),
      shouldClaimAndClose,
    });

    let txArray: Transaction[];

    try {
      const txOrTxs = await pool.removeLiquidity({
        user: userPubkey,
        position: positionPubkey,
        fromBinId: minBinId,
        toBinId: maxBinId,
        bps: new BN(10000), // 100%
        shouldClaimAndClose,
      });

      txArray = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
    } catch (err: any) {
      const errMsg = (err.message || '').toLowerCase();
      if (errMsg.includes('no liquidity') || errMsg.includes('empty')) {
        logger.info('Position has no liquidity, using closePositionIfEmpty to reclaim rent');

        // Fall back: close the empty position account to reclaim rent
        const closeTx = await pool.closePositionIfEmpty({
          owner: userPubkey,
          position: { publicKey: positionPubkey } as any,
        });

        txArray = Array.isArray(closeTx) ? closeTx : [closeTx];
      } else {
        throw err;
      }
    }

    if (keypair) {
      const signatures: string[] = [];
      for (const tx of txArray) {
        const sig = await signAndSendTransaction(tx, keypair);
        signatures.push(sig);
      }
      return { signature: signatures.join(',') };
    }

    // For wallet adapter: set blockhash + feePayer on each tx before serializing
    const conn = getConnection();
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

    const serializedParts: string[] = [];
    for (const tx of txArray) {
      if (tx instanceof Transaction) {
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = userPubkey;
      }
      serializedParts.push(serializeTransaction(tx));
    }
    return { serializedTx: serializedParts.join('|'), blockhash, lastValidBlockHeight };
  }

  /**
   * Claim all rewards (swap fees + LM rewards) for positions
   */
  async claimAllRewards(params: {
    pool: DLMM;
    ownerPubkey: PublicKey;
    keypair?: Keypair;
  }): Promise<{ signature?: string; serializedTx?: string }> {
    const { pool, ownerPubkey, keypair } = params;

    const { userPositions } = await pool.getPositionsByUserAndLbPair(ownerPubkey);
    if (userPositions.length === 0) {
      logger.info('No positions found for reward claiming');
      return {};
    }

    logger.info('Claiming all rewards', {
      positionCount: userPositions.length,
    });

    const txs = await pool.claimAllRewards({
      owner: ownerPubkey,
      positions: userPositions,
    });

    if (keypair && txs.length > 0) {
      const signatures: string[] = [];
      for (const tx of txs) {
        const sig = await signAndSendTransaction(tx, keypair);
        signatures.push(sig);
      }
      return { signature: signatures.join(',') };
    }

    if (txs.length > 0) {
      const serialized = txs.map(tx => serializeTransaction(tx)).join('|');
      return { serializedTx: serialized };
    }

    return {};
  }

  /**
   * Check if a position is in range by comparing active bin to position's range
   */
  async isPositionInRange(
    pool: DLMM,
    minBinId: number,
    maxBinId: number
  ): Promise<{ inRange: boolean; activeBinId: number }> {
    const activeBin = await pool.getActiveBin();
    const activeBinId = activeBin.binId;
    const inRange = activeBinId >= minBinId && activeBinId <= maxBinId;
    return { inRange, activeBinId };
  }

  /**
   * Get dynamic fee for current market conditions
   */
  getDynamicFee(pool: DLMM) {
    return pool.getDynamicFee();
  }

  /**
   * Calculate actual claimable fees for positions by summing per-bin fee amounts
   * from positionBinData. Returns fees in SOL equivalent.
   *
   * The raw positionData.feeX/feeY are internal checkpoint values (NOT claimable amounts).
   * The real claimable fees live in positionBinData[].positionFeeXAmount/positionFeeYAmount.
   */
  async getClaimableFees(
    pool: DLMM,
    ownerPubkey: PublicKey,
  ): Promise<Map<string, number>> {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const positionFees = new Map<string, number>();

    const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(ownerPubkey);

    if (userPositions.length === 0) return positionFees;

    // Determine which token side is SOL
    const tokenXMint = pool.tokenX.publicKey.toBase58();
    const solSide: 'X' | 'Y' = tokenXMint === SOL_MINT ? 'X' : 'Y';

    // activeBin.price is the RAW mathematical price: (1 + binStep/10000)^binId
    // This is a ratio between raw token units, NOT decimal-adjusted.
    // 1 raw X unit = rawPrice raw Y units.
    // Since raw price handles decimal differences implicitly, we only
    // divide by 1e9 (SOL lamports) to get SOL.
    const rawPrice = parseFloat(activeBin.price);

    for (const pos of userPositions) {
      let totalFeeXRaw = 0;
      let totalFeeYRaw = 0;

      const binData = pos.positionData?.positionBinData;
      if (!binData || binData.length === 0) {
        positionFees.set(pos.publicKey.toBase58(), 0);
        continue;
      }

      for (const bin of binData) {
        totalFeeXRaw += parseFloat(bin.positionFeeXAmount || '0');
        totalFeeYRaw += parseFloat(bin.positionFeeYAmount || '0');
      }

      let feeSol: number;
      if (solSide === 'X') {
        // tokenX is SOL: feeX is in lamports
        const feeXSol = totalFeeXRaw / 1e9;
        // tokenY is non-SOL: convert raw Y → raw X (SOL lamports) via 1/rawPrice
        const feeYSol = rawPrice > 0 ? (totalFeeYRaw / rawPrice) / 1e9 : 0;
        feeSol = feeXSol + feeYSol;
      } else {
        // tokenY is SOL: feeY is in lamports
        const feeYSol = totalFeeYRaw / 1e9;
        // tokenX is non-SOL: convert raw X → raw Y (SOL lamports) via rawPrice
        const feeXSol = (totalFeeXRaw * rawPrice) / 1e9;
        feeSol = feeXSol + feeYSol;
      }

      positionFees.set(pos.publicKey.toBase58(), feeSol);
    }

    return positionFees;
  }
}

// Singleton instance
let meteoraService: MeteoraService | null = null;

export function getMeteoraService(): MeteoraService {
  if (!meteoraService) {
    meteoraService = new MeteoraService();
  }
  return meteoraService;
}
