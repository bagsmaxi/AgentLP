'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';
import { Search, Flame, Loader2, CheckCircle, AlertCircle, Wallet } from 'lucide-react';
import { startAgent, confirmPosition, fetchBalance } from '@/lib/api';

type Status = 'idle' | 'analyzing' | 'awaiting_sign' | 'confirming' | 'success' | 'error';

export function DepositForm() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [solAmount, setSolAmount] = useState('');
  const [mode, setMode] = useState<'assisted' | 'degen'>('assisted');
  const [tokenMint, setTokenMint] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [resultData, setResultData] = useState<any>(null);
  const [balance, setBalance] = useState<number | null>(null);

  // Fetch balance when wallet connects
  useEffect(() => {
    if (!publicKey) { setBalance(null); return; }
    fetchBalance(publicKey.toBase58())
      .then(d => setBalance(d.balance))
      .catch(() => {});
    const interval = setInterval(() => {
      fetchBalance(publicKey.toBase58())
        .then(d => setBalance(d.balance))
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(interval);
  }, [publicKey]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey || !solAmount) return;

    const amount = parseFloat(solAmount);
    if (isNaN(amount) || amount <= 0) return;

    // Assisted mode requires a token CA
    if (mode === 'assisted' && !tokenMint.trim()) return;

    try {
      setStatus('analyzing');
      setStatusMsg(mode === 'degen'
        ? 'DEGEN mode: hunting highest APR pools...'
        : `Finding best SOL pool for token...`);
      setResultData(null);

      const data = await startAgent({
        walletAddress: publicKey.toBase58(),
        mode,
        solAmount: amount,
        ...(mode === 'assisted' && tokenMint.trim() ? { tokenMint: tokenMint.trim() } : {}),
      });
      setStatusMsg(`Best pool: ${data.selectedPool?.name}. Preparing transaction...`);

      // If we got a serialized transaction, send it to wallet for signing
      if (data.transaction || data.serializedTx) {
        const txBase64 = data.transaction || data.serializedTx;

        setStatus('awaiting_sign');
        setStatusMsg('Please approve the transaction in your wallet...');

        const txBuffer = Buffer.from(txBase64, 'base64');
        const transaction = Transaction.from(txBuffer);

        const signature = await sendTransaction(transaction, connection, {
          maxRetries: 3,
        });

        setStatus('confirming');
        setStatusMsg(`Transaction sent! Confirming... (${signature.slice(0, 8)}...)`);

        const blockhash = data.blockhash || transaction.recentBlockhash!;
        const lastValidBlockHeight = data.lastValidBlockHeight
          || (await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight;

        await connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight,
        }, 'confirmed');

        const poolInfo = data.selectedPool;
        await confirmPosition({
          walletAddress: publicKey.toBase58(),
          poolAddress: poolInfo.address,
          poolName: poolInfo.name,
          positionPubkey: data.positionPubkey,
          solDeposited: amount,
          strategy: data.strategy,
          mode,
          sessionId: data.sessionId,
          pairedTokenMint: data.pairedTokenMint,
        });

        setStatus('success');
        setStatusMsg(
          `Position created in ${poolInfo.name}! Strategy: ${data.strategy?.strategyType || 'auto'}`
        );
        setResultData({ signature, pool: poolInfo, strategy: data.strategy });
      } else if (data.signature) {
        setStatus('success');
        setStatusMsg(`Position created! Signature: ${data.signature.slice(0, 16)}...`);
        setResultData(data);
      } else {
        setStatus('error');
        setStatusMsg('No transaction returned from server. Please try again.');
      }
    } catch (err: any) {
      console.error('Deposit error:', err);
      setStatus('error');
      setStatusMsg(err.message || 'Transaction failed. Please try again.');
    }
  }, [publicKey, solAmount, mode, tokenMint, sendTransaction, connection]);

  const isLoading = status === 'analyzing' || status === 'awaiting_sign' || status === 'confirming';

  const resetForm = () => {
    setStatus('idle');
    setStatusMsg('');
    setResultData(null);
  };

  const canSubmit = publicKey && solAmount && !isLoading
    && (mode === 'degen' || tokenMint.trim().length > 0);

  return (
    <form onSubmit={handleSubmit} className="glass-card rounded-2xl p-6">
      <h2 className="text-xl font-bold mb-5 tracking-tight">Start LP Farming</h2>

      {/* Mode Selection */}
      <div className="flex gap-3 mb-6">
        <button
          type="button"
          onClick={() => { setMode('assisted'); resetForm(); }}
          className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${
            mode === 'assisted'
              ? 'border-meteora-blue/50 bg-meteora-blue/10 text-meteora-blue'
              : 'border-white/5 text-gray-400 hover:border-white/10'
          }`}
        >
          <Search size={18} />
          Assisted
        </button>
        <button
          type="button"
          onClick={() => { setMode('degen'); resetForm(); }}
          className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${
            mode === 'degen'
              ? 'border-orange-500/50 bg-orange-500/10 text-orange-400'
              : 'border-white/5 text-gray-400 hover:border-white/10'
          }`}
        >
          <Flame size={18} />
          DEGEN
        </button>
      </div>

      <p className="text-sm text-gray-400 mb-4">
        {mode === 'assisted'
          ? 'Paste a token CA and the agent finds the best SOL pool for it on Meteora.'
          : 'Agent targets highest APR pools. May pick volatile memecoins or fresh pairs. Higher risk, higher reward.'}
      </p>

      {/* Token CA Input (Assisted mode only) */}
      {mode === 'assisted' && (
        <div className="mb-4">
          <label className="text-sm text-gray-400 mb-2 block">Token Contract Address</label>
          <input
            type="text"
            value={tokenMint}
            onChange={e => { setTokenMint(e.target.value); if (status !== 'idle') resetForm(); }}
            placeholder="Paste token CA (mint address)..."
            disabled={isLoading}
            className="w-full bg-dark-850 border border-white/5 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:border-meteora-blue/50 disabled:opacity-50 placeholder:text-gray-600"
          />
        </div>
      )}

      {/* DEGEN Warning */}
      {mode === 'degen' && (
        <div className="mb-4 p-3 bg-orange-900/20 border border-orange-700/30 rounded-xl text-sm text-orange-300 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>DEGEN mode targets high APR pools with lower liquidity. Higher impermanent loss risk.</span>
        </div>
      )}

      {/* SOL Amount Input */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-gray-400">SOL Amount</label>
          {balance !== null && (
            <div className="flex items-center gap-2 text-sm">
              <Wallet size={14} className="text-gray-400" />
              <span className="text-gray-400">{balance.toFixed(4)} SOL</span>
              <button
                type="button"
                onClick={() => {
                  const max = Math.max(0, balance - 0.05);
                  setSolAmount(max.toFixed(4));
                  if (status !== 'idle') resetForm();
                }}
                className="text-xs text-meteora-blue hover:text-blue-300 font-semibold"
              >
                MAX
              </button>
            </div>
          )}
        </div>
        <div className="relative">
          <input
            type="number"
            value={solAmount}
            onChange={e => { setSolAmount(e.target.value); if (status !== 'idle') resetForm(); }}
            placeholder="0.00"
            step="0.01"
            min="0.01"
            disabled={isLoading}
            className="w-full bg-dark-850 border border-white/5 rounded-xl px-4 py-3 text-lg focus:outline-none focus:border-meteora-blue/50 disabled:opacity-50"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">SOL</span>
        </div>
      </div>


      {/* Submit Button */}
      <button
        type="submit"
        disabled={!canSubmit}
        className={`w-full py-3 rounded-xl font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 btn-glow ${
          mode === 'degen'
            ? 'bg-gradient-to-r from-orange-600 to-red-600 hover:opacity-90'
            : 'bg-gradient-to-r from-meteora-purple to-meteora-blue hover:opacity-90'
        }`}
      >
        {isLoading && <Loader2 size={18} className="animate-spin" />}
        {isLoading
          ? status === 'analyzing'
            ? 'Analyzing pools...'
            : status === 'awaiting_sign'
            ? 'Approve in wallet...'
            : 'Confirming...'
          : !publicKey
          ? 'Connect Wallet First'
          : mode === 'assisted'
          ? 'Start Assisted Farming'
          : 'Start DEGEN Farming'}
      </button>

      {/* Status Messages */}
      {statusMsg && (
        <div className={`mt-3 p-3 rounded-xl text-sm flex items-start gap-2 ${
          status === 'success'
            ? 'bg-green-900/20 border border-green-700/30 text-green-300'
            : status === 'error'
            ? 'bg-red-900/20 border border-red-700/30 text-red-300'
            : 'bg-blue-900/20 border border-blue-700/30 text-blue-300'
        }`}>
          {status === 'success' && <CheckCircle size={16} className="mt-0.5 flex-shrink-0" />}
          {status === 'error' && <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />}
          {isLoading && <Loader2 size={16} className="mt-0.5 flex-shrink-0 animate-spin" />}
          <div>
            <div>{statusMsg}</div>
            {resultData?.signature && (
              <a
                href={`https://solscan.io/tx/${resultData.signature}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline mt-1 inline-block opacity-80 hover:opacity-100"
              >
                View on Solscan
              </a>
            )}
          </div>
        </div>
      )}

      {/* Reset after success/error */}
      {(status === 'success' || status === 'error') && (
        <button
          type="button"
          onClick={resetForm}
          className="w-full mt-2 py-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          {status === 'success' ? 'Create Another Position' : 'Try Again'}
        </button>
      )}
    </form>
  );
}
