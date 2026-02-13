'use client';

import React from 'react';
import { useAnalytics } from '@/lib/hooks';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

const COLORS = ['#00D1FF', '#7B61FF', '#10B981', '#F59E0B'];

export function PerformanceChart() {
  const { data: analytics, isLoading } = useAnalytics();

  if (isLoading || !analytics) {
    return (
      <div className="bg-dark-800 rounded-xl p-6 border border-dark-600">
        <h2 className="text-xl font-bold mb-4">Performance</h2>
        <div className="h-64 animate-pulse bg-dark-700 rounded-lg" />
      </div>
    );
  }

  const outcomes = analytics.outcomes || { profit: 0, loss: 0, breakeven: 0 };
  const outcomeData = [
    { name: 'Profit', value: outcomes.profit },
    { name: 'Loss', value: outcomes.loss },
    { name: 'Breakeven', value: outcomes.breakeven },
  ].filter(d => d.value > 0);

  const recentLogs = (analytics.recentLogs || []).slice(0, 10).map((log: any) => ({
    pool: log.poolAddress?.slice(0, 8) + '...',
    fees: log.feesEarned,
    strategy: log.strategy,
  }));

  return (
    <div className="bg-dark-800 rounded-xl p-6 border border-dark-600">
      <h2 className="text-xl font-bold mb-4">Performance Analytics</h2>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Fees Chart */}
        <div>
          <h3 className="text-sm text-gray-400 mb-3">Recent Fees Earned (SOL)</h3>
          {recentLogs.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={recentLogs}>
                <CartesianGrid strokeDasharray="3 3" stroke="#252540" />
                <XAxis dataKey="pool" tick={{ fill: '#888', fontSize: 11 }} />
                <YAxis tick={{ fill: '#888', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid #252540' }}
                />
                <Bar dataKey="fees" fill="#00D1FF" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-gray-500">
              No performance data yet
            </div>
          )}
        </div>

        {/* Outcomes Pie */}
        <div>
          <h3 className="text-sm text-gray-400 mb-3">Position Outcomes</h3>
          {outcomeData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={outcomeData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {outcomeData.map((_, idx) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid #252540' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-gray-500">
              No outcome data yet
            </div>
          )}
          <div className="flex justify-center gap-4 mt-2">
            {outcomeData.map((d, i) => (
              <div key={d.name} className="flex items-center gap-1 text-xs">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ background: COLORS[i % COLORS.length] }}
                />
                {d.name}: {d.value}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
