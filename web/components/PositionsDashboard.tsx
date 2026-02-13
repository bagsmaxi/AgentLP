'use client';

import React from 'react';
import { usePositions, useAnalytics } from '@/lib/hooks';
import { PositionCard } from './PositionCard';
import { BarChart3, Coins, RefreshCw, TrendingUp } from 'lucide-react';

export function PositionsDashboard() {
  const { data: positions, isLoading: posLoading, refetch } = usePositions();
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics();

  if (posLoading) {
    return (
      <div className="space-y-5">
        <h2 className="text-xl font-bold tracking-tight">Your Positions</h2>
        <div className="animate-pulse space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-40 bg-dark-750/50 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const summary = analytics?.summary;

  return (
    <div className="space-y-8">
      {/* Summary Stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon={<Coins size={18} />}
            iconColor="bg-meteora-blue/10 text-meteora-blue"
            label="Total Deposited"
            value={`${summary.totalSolDeposited?.toFixed(2)} SOL`}
          />
          <StatCard
            icon={<TrendingUp size={18} />}
            iconColor="bg-green-400/10 text-green-400"
            label="Total Earned"
            value={`${summary.totalReturn?.toFixed(4)} SOL`}
          />
          <StatCard
            icon={<BarChart3 size={18} />}
            iconColor="bg-meteora-purple/10 text-meteora-purple"
            label="Active Positions"
            value={`${summary.activePositions}`}
          />
          <StatCard
            icon={<RefreshCw size={18} />}
            iconColor="bg-yellow-400/10 text-yellow-400"
            label="Rebalances"
            value={`${summary.totalRebalances}`}
          />
        </div>
      )}

      {/* Positions List */}
      <div>
        <h2 className="text-xl font-bold mb-5 tracking-tight">Your Positions</h2>
        {!positions || positions.length === 0 ? (
          <div className="glass-card rounded-2xl p-10 text-center text-gray-500">
            No positions yet. Start by depositing SOL above.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {positions.map((pos: any) => (
              <PositionCard key={pos.id} position={pos} onClosed={() => refetch()} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  iconColor,
  label,
  value,
}: {
  icon: React.ReactNode;
  iconColor: string;
  label: string;
  value: string;
}) {
  return (
    <div className="glass-card rounded-2xl p-5 relative stat-accent">
      <div className="flex items-center gap-2.5 mb-2">
        <div className={`p-2 rounded-lg ${iconColor}`}>
          {icon}
        </div>
        <span className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-xl font-bold tracking-tight">{value}</div>
    </div>
  );
}
