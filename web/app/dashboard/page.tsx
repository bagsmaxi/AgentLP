'use client';

import React from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletButton } from '@/components/WalletButton';
import { PositionsDashboard } from '@/components/PositionsDashboard';
import { PerformanceChart } from '@/components/PerformanceChart';
import { Bot } from 'lucide-react';
import Link from 'next/link';

export default function DashboardPage() {
  const { connected } = useWallet();

  return (
    <div className="min-h-screen bg-dark-900">
      <header className="border-b border-dark-600 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-3">
              <Bot size={28} className="text-meteora-blue" />
              <h1 className="text-xl font-bold bg-gradient-to-r from-meteora-purple to-meteora-blue bg-clip-text text-transparent">
                AgentLP
              </h1>
            </Link>
            <span className="text-gray-500 ml-2">/ Dashboard</span>
          </div>
          <WalletButton />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {connected ? (
          <>
            <PositionsDashboard />
            <PerformanceChart />
          </>
        ) : (
          <div className="text-center py-20">
            <p className="text-gray-400 mb-4">Connect your wallet to view your dashboard.</p>
            <WalletButton />
          </div>
        )}
      </main>
    </div>
  );
}
