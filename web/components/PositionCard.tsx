'use client';

import React, { useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { CheckCircle, AlertTriangle, Loader2, AlertCircle, LogOut, ExternalLink } from 'lucide-react';
import { closePosition, confirmClosePosition, swapToSol } from '@/lib/api';

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

export function PositionCard({ position, onClosed }: PositionCardProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [closeStatus, setCloseStatus] = useState<CloseStatus>('idle');
  const [closeError, setCloseError] = useState('');

  const statusConfig = {
    active: { icon: <CheckCircle size={14} />, color: 'text-green-400 bg-green-500/10 border-green-500/20', label: 'Active' },
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

          let swapSig: string;
          if (swapBuffer[0] & 0x80) {
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

  const isClosing = closeStatus === 'loading' || closeStatus === 'signing' || closeStatus === 'confirming' || closeStatus === 'swapping' || closeStatus === 'signing_swap';
  const showCloseButton = position.status === 'active' && closeStatus !== 'done';

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
        <span>{new Date(position.createdAt).toLocaleDateString()}</span>
      </div>

      {/* Action button */}
      {showCloseButton && (
        <div className="mt-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={isClosing}
            className="w-full py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-red-700 hover:opacity-90"
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
        </div>
      )}

      {/* Success state */}
      {closeStatus === 'done' && (
        <div className="mt-4 p-3 rounded-xl text-sm bg-green-900/15 border border-green-500/20 text-green-300 flex items-center gap-2">
          <CheckCircle size={14} />
          Position closed. All tokens converted to SOL and returned to your wallet.
        </div>
      )}

      {/* Error state */}
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
    </div>
  );
}
