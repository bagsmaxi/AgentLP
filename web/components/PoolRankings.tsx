'use client';

import React from 'react';
import { usePools } from '@/lib/hooks';
import { Brain } from 'lucide-react';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function formatVol(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function getMomentumLabel(m: number): { text: string; color: string } | null {
  if (m >= 0.7) return { text: 'HOT', color: 'text-red-400 bg-red-500/10 border-red-500/20' };
  if (m >= 0.4) return { text: 'RISING', color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' };
  return null;
}

export function PoolRankings() {
  const { data: pools, isLoading, error } = usePools(10);

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-meteora-blue/10">
            <Brain size={16} className="text-meteora-blue" />
          </div>
          <h2 className="font-bold tracking-tight">Top SOL Pools</h2>
        </div>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">AI Ranked</span>
      </div>

      {isLoading ? (
        <div className="p-5 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 bg-dark-750/50 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="p-5 text-red-400 text-sm">{error.message}</div>
      ) : (
        <div>
          {/* Table header */}
          <div className="grid grid-cols-12 gap-2 px-6 py-2.5 text-[10px] text-gray-500 uppercase tracking-wider font-medium border-b border-white/[0.03]">
            <div className="col-span-4">Pool</div>
            <div className="col-span-2 text-right">APR</div>
            <div className="col-span-2 text-right">Vol 24h</div>
            <div className="col-span-2 text-right">Vol 4h</div>
            <div className="col-span-2 text-right">Fees 24h</div>
          </div>

          {pools?.map((pool: any, i: number) => {
            const momentum = getMomentumLabel(pool.volumeMomentum || 0);
            const tokenMint = pool.mintX === SOL_MINT ? pool.mintY : pool.mintX;

            return (
              <div
                key={pool.address}
                className="grid grid-cols-12 gap-2 items-center px-6 py-3 table-row-hover border-b border-white/[0.03] last:border-0"
              >
                {/* Pool name + links */}
                <div className="col-span-4 min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] font-mono text-gray-600 bg-dark-750/50 w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-sm truncate">{pool.name}</span>
                        {momentum && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-md border font-semibold ${momentum.color}`}>
                            {momentum.text}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <a
                          href={`https://dexscreener.com/solana/${tokenMint}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-emerald-500/70 hover:text-emerald-400"
                        >
                          Chart
                        </a>
                        <a
                          href={`https://app.meteora.ag/dlmm/${pool.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-meteora-blue/70 hover:text-meteora-blue"
                        >
                          Pool
                        </a>
                        <span className="text-[10px] text-gray-600">{pool.binStep}bs</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="col-span-2 text-right">
                  <span className="text-sm font-semibold text-green-400">{pool.feeApr?.toFixed(0)}%</span>
                </div>

                <div className="col-span-2 text-right">
                  <span className="text-sm text-gray-300">{formatVol(pool.volume24h || 0)}</span>
                </div>

                <div className="col-span-2 text-right">
                  <span className={`text-sm ${(pool.volumeMomentum || 0) >= 0.4 ? 'text-yellow-400' : 'text-gray-400'}`}>
                    {formatVol(pool.volume4h || 0)}
                  </span>
                </div>

                <div className="col-span-2 text-right">
                  <span className="text-sm text-blue-400">{formatVol(pool.fees24h || 0)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
