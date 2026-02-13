'use client';

import React, { useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { CheckCircle, AlertTriangle, RefreshCw, Loader2, AlertCircle, LogOut, ExternalLink } from 'lucide-react';
import { closePosition, confirmClosePosition, rebalancePosition, confirmRebalance, swapToSol } from '@/lib/api';

interface PositionCardProps {
  position: {
    id: string;
    poolAddress: string;
    poolName: string;
    pairedTokenMint?: string;
    positionPubkey: string;
    status: string;
    solDeposited: number;
    strategy: string;
    minBinId: number;
    maxBinId: number;
    totalFeesEarned: number;
    unclaimedFees?: number;
    totalRewardsEarned: number;
    rebalanceCount: number;
    createdAt: string;
  };
  onClosed?: () => void;
}

type CloseStatus = 'idle' | 'loading' | 'signing' | 'confirming' | 'swapping' | 'signing_swap' | 'done' | 'error';
type RebalanceStatus = 'idle' | 'loading' | 'signing_close' | 'signing_new' | 'confirming' | 'done' | 'error';

export function PositionCard({ position, onClosed }: PositionCardProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [closeStatus, setCloseStatus] = useState<CloseStatus>('idle');
  const [closeError, setCloseError] = useState('');
  const [rebalanceStatus, setRebalanceStatus] = useState<RebalanceStatus>('idle');
  const [rebalanceError, setRebalanceError] = useState('');

  const statusConfig = {
    active: { icon: <CheckCircle size={14} />, color: 'text-green-400 bg-green-500/10 border-green-500/20', label: 'Active' },
    rebalancing: { icon: <RefreshCw size={14} className="animate-spin" />, color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20', label: 'Rebalancing' },
    closed: { icon: <AlertTriangle size={14} />, color: 'text-gray-500 bg-gray-500/10 border-gray-500/20', label: 'Closed' },
  }[position.status] || { icon: null, color: 'text-gray-400 bg-gray-500/10 border-gray-500/20', label: position.status };

  const totalReturn = position.totalFeesEarned + position.totalRewardsEarned;
  const roi = position.solDeposited > 0
    ? ((totalReturn / position.solDeposited) * 100).toFixed(2)
    : '0.00';

  const handleClose = async () => {
    if (!publicKey) return;

    try {
      setCloseStatus('loading');
      setCloseError('');

      const data = await closePosition(position.id, publicKey.toBase58());

      if (!data.serializedTxs || data.serializedTxs.length === 0) {
        setCloseStatus('done');
        onClosed?.();
        return;
      }

      setCloseStatus('signing');

      for (const txBase64 of data.serializedTxs) {
        const txBuffer = Buffer.from(txBase64, 'base64');
        const transaction = Transaction.from(txBuffer);

        const signature = await sendTransaction(transaction, connection, {
          maxRetries: 3,
        });

        setCloseStatus('confirming');

        await connection.confirmTransaction({
          signature,
          blockhash: data.blockhash,
          lastValidBlockHeight: data.lastValidBlockHeight,
        }, 'confirmed');
      }

      await confirmClosePosition(position.id, publicKey.toBase58());

      // Auto-swap non-SOL tokens to SOL (100% SOL rewards)
      setCloseStatus('swapping');
      try {
        const swapData = await swapToSol(position.id, publicKey.toBase58());
        if (swapData.serializedTx && !swapData.noSwapNeeded) {
          setCloseStatus('signing_swap');
          const swapBuffer = Buffer.from(swapData.serializedTx, 'base64');

          // Jupiter may return a VersionedTransaction — detect by checking first byte
          // VersionedTransaction starts with a version byte (0x80), legacy Transaction doesn't
          let swapSig: string;
          if (swapBuffer[0] & 0x80) {
            // VersionedTransaction — use sendRawTransaction
            const { VersionedTransaction: VTx } = await import('@solana/web3.js');
            const vtx = VTx.deserialize(swapBuffer);
            swapSig = await connection.sendRawTransaction(swapBuffer, { maxRetries: 3 });
          } else {
            const swapTx = Transaction.from(swapBuffer);
            swapSig = await sendTransaction(swapTx, connection, { maxRetries: 3 });
          }

          await connection.confirmTransaction(swapSig, 'confirmed');
        }
      } catch (swapErr: any) {
        // Swap failure is non-critical — position is already closed
        console.warn('Token-to-SOL swap failed (non-critical):', swapErr.message);
      }

      setCloseStatus('done');
      onClosed?.();
    } catch (err: any) {
      console.error('Close position error:', err);
      setCloseStatus('error');
      setCloseError(err.message || 'Failed to close position');
    }
  };

  const handleRebalance = async () => {
    if (!publicKey) return;

    try {
      setRebalanceStatus('loading');
      setRebalanceError('');

      const data = await rebalancePosition(position.id, publicKey.toBase58());

      setRebalanceStatus('signing_close');

      for (const txBase64 of data.closeTxs) {
        const txBuffer = Buffer.from(txBase64, 'base64');
        const transaction = Transaction.from(txBuffer);
        const signature = await sendTransaction(transaction, connection, { maxRetries: 3 });
        await connection.confirmTransaction({
          signature,
          blockhash: data.closeTxBlockhash,
          lastValidBlockHeight: data.closeTxLastValidBlockHeight,
        }, 'confirmed');
      }

      setRebalanceStatus('signing_new');
      const newTxBuffer = Buffer.from(data.newPositionTx, 'base64');
      const newTransaction = Transaction.from(newTxBuffer);
      const newSig = await sendTransaction(newTransaction, connection, { maxRetries: 3 });

      setRebalanceStatus('confirming');
      const newBlockhash = data.newPositionBlockhash || newTransaction.recentBlockhash!;
      const newLastValid = data.newPositionLastValidBlockHeight
        || (await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight;

      await connection.confirmTransaction({
        signature: newSig,
        blockhash: newBlockhash,
        lastValidBlockHeight: newLastValid,
      }, 'confirmed');

      await confirmRebalance(position.id, {
        walletAddress: publicKey.toBase58(),
        newPositionPubkey: data.newPositionPubkey,
        poolAddress: data.poolAddress,
        poolName: data.poolName,
        strategy: data.newPositionStrategy,
        solDeposited: position.solDeposited,
      });

      setRebalanceStatus('done');
      onClosed?.();
    } catch (err: any) {
      console.error('Rebalance error:', err);
      setRebalanceStatus('error');
      setRebalanceError(err.message || 'Rebalance failed');
    }
  };

  const isClosing = closeStatus === 'loading' || closeStatus === 'signing' || closeStatus === 'confirming' || closeStatus === 'swapping' || closeStatus === 'signing_swap';
  const isRebalancing = rebalanceStatus === 'loading' || rebalanceStatus === 'signing_close' || rebalanceStatus === 'signing_new' || rebalanceStatus === 'confirming';
  const showCloseButton = position.status === 'active' && closeStatus !== 'done' && !isRebalancing;
  const showRebalanceButton = position.status === 'active' && closeStatus !== 'done' && rebalanceStatus !== 'done' && !isClosing;

  return (
    <div className="glass-card rounded-2xl p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-lg tracking-tight">{position.poolName}</h3>
        <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
          closeStatus === 'done' ? 'text-gray-500 bg-gray-500/10 border-gray-500/20' : statusConfig.color
        }`}>
          {closeStatus === 'done' ? <AlertTriangle size={12} /> : statusConfig.icon}
          <span>{closeStatus === 'done' ? 'Closed' : statusConfig.label}</span>
        </div>
      </div>

      {/* Links */}
      <div className="flex items-center gap-3 mb-4">
        <a
          href={`https://dexscreener.com/solana/${position.pairedTokenMint || position.poolAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-emerald-400/70 hover:text-emerald-300"
        >
          Dexscreener <ExternalLink size={9} />
        </a>
        <a
          href={`https://app.meteora.ag/dlmm/${position.poolAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-meteora-blue/70 hover:text-meteora-blue"
        >
          Meteora <ExternalLink size={9} />
        </a>
        <a
          href={`https://solscan.io/account/${position.positionPubkey}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300"
        >
          Solscan <ExternalLink size={9} />
        </a>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-4">
        <div>
          <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-0.5">Deposited</div>
          <div className="font-mono text-base">{position.solDeposited.toFixed(4)} SOL</div>
        </div>
        <div>
          <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-0.5">Fees Earned</div>
          <div className="font-mono text-base text-green-400">
            +{totalReturn.toFixed(6)} SOL
          </div>
        </div>
        <div>
          <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-0.5">Strategy</div>
          <div className="text-base">{position.strategy}</div>
        </div>
        <div>
          <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-0.5">ROI</div>
          <div className={`text-base font-semibold ${parseFloat(roi) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {roi}%
          </div>
        </div>
      </div>

      {/* Meta */}
      <div className="flex items-center justify-between text-[10px] text-gray-600 border-t border-white/5 pt-3 mt-1">
        <span>Bins: {position.minBinId} - {position.maxBinId}</span>
        <span>Rebalanced: {position.rebalanceCount}x</span>
        <span>{new Date(position.createdAt).toLocaleDateString()}</span>
      </div>

      {/* Action buttons */}
      {(showRebalanceButton || showCloseButton) && (
        <div className="flex gap-2 mt-4">
          {showRebalanceButton && (
            <button
              type="button"
              onClick={handleRebalance}
              disabled={isRebalancing}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:opacity-90 btn-glow"
            >
              {isRebalancing ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  {rebalanceStatus === 'loading'
                    ? 'Preparing...'
                    : rebalanceStatus === 'signing_close'
                    ? 'Close old...'
                    : rebalanceStatus === 'signing_new'
                    ? 'Open new...'
                    : 'Confirming...'}
                </>
              ) : (
                <>
                  <RefreshCw size={15} />
                  Rebalance
                </>
              )}
            </button>
          )}
          {showCloseButton && (
            <button
              type="button"
              onClick={handleClose}
              disabled={isClosing}
              className="flex-1 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-red-700 hover:opacity-90"
            >
              {isClosing ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  {closeStatus === 'loading'
                    ? 'Preparing...'
                    : closeStatus === 'signing'
                    ? 'Approve in wallet...'
                    : closeStatus === 'confirming'
                    ? 'Confirming...'
                    : closeStatus === 'swapping'
                    ? 'Converting to SOL...'
                    : 'Approve swap...'}
                </>
              ) : (
                <>
                  <LogOut size={15} />
                  Withdraw
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Success states */}
      {closeStatus === 'done' && (
        <div className="mt-4 p-3 rounded-xl text-sm bg-green-900/15 border border-green-500/20 text-green-300 flex items-center gap-2">
          <CheckCircle size={14} />
          Position closed. All tokens converted to SOL and returned to your wallet.
        </div>
      )}

      {rebalanceStatus === 'done' && (
        <div className="mt-4 p-3 rounded-xl text-sm bg-green-900/15 border border-green-500/20 text-green-300 flex items-center gap-2">
          <CheckCircle size={14} />
          Rebalanced! New position created at current price range.
        </div>
      )}

      {/* Error states */}
      {closeStatus === 'error' && (
        <div className="mt-4 p-3 rounded-xl text-sm bg-red-900/15 border border-red-500/20 text-red-300 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            <div>{closeError}</div>
            <button
              type="button"
              onClick={() => { setCloseStatus('idle'); setCloseError(''); }}
              className="text-xs underline mt-1 opacity-80 hover:opacity-100"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {rebalanceStatus === 'error' && (
        <div className="mt-4 p-3 rounded-xl text-sm bg-red-900/15 border border-red-500/20 text-red-300 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            <div>{rebalanceError}</div>
            <button
              type="button"
              onClick={() => { setRebalanceStatus('idle'); setRebalanceError(''); }}
              className="text-xs underline mt-1 opacity-80 hover:opacity-100"
            >
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
