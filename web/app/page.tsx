'use client';

import React from 'react';
import Image from 'next/image';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletButton } from '@/components/WalletButton';
import { DepositForm } from '@/components/DepositForm';
import { PoolRankings } from '@/components/PoolRankings';
import { PositionsDashboard } from '@/components/PositionsDashboard';
import { NotificationBell } from '@/components/NotificationBell';
import { Zap, TrendingUp, Brain, Shield } from 'lucide-react';

export default function Home() {
  const { connected } = useWallet();

  if (!connected) {
    return <LandingPage />;
  }

  return (
    <div className="min-h-screen bg-dark-900 hero-mesh">
      {/* Header */}
      <header className="border-b border-white/5 backdrop-blur-md sticky top-0 z-40 bg-dark-900/60">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/logo.png" alt="LPCLAW" width={32} height={32} className="rounded-xl" />
            <span className="text-lg font-bold tracking-tight">LPCLAW</span>
          </div>
          <div className="flex items-center gap-3">
            <NotificationBell />
            <WalletButton />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Top row: Deposit + Pool Rankings */}
        <div className="grid lg:grid-cols-5 gap-6">
          <div className="lg:col-span-2">
            <DepositForm />
          </div>
          <div className="lg:col-span-3">
            <PoolRankings />
          </div>
        </div>

        {/* Positions */}
        <PositionsDashboard />
      </main>
    </div>
  );
}

function LandingPage() {
  return (
    <div className="min-h-screen bg-dark-900 flex flex-col hero-mesh">
      {/* Decorative gradient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-meteora-purple/[0.06] rounded-full blur-[100px]" />
        <div className="absolute top-1/3 -right-20 w-80 h-80 bg-meteora-blue/[0.05] rounded-full blur-[80px]" />
        <div className="absolute bottom-0 left-1/3 w-72 h-72 bg-meteora-purple/[0.04] rounded-full blur-[100px]" />
      </div>

      {/* Header */}
      <header className="px-6 py-5 relative z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/logo.png" alt="LPCLAW" width={36} height={36} className="rounded-xl" />
            <span className="text-xl font-bold tracking-tight">LPCLAW</span>
          </div>
          <WalletButton />
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-6 relative z-10">
        <div className="max-w-xl text-center">
          <Image
            src="/logo.png"
            alt="LPCLAW"
            width={80}
            height={80}
            className="mx-auto mb-8 rounded-2xl"
          />

          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full glass-card text-xs text-meteora-blue mb-6">
            <Zap size={12} />
            AI-Powered Meteora DLMM
          </div>

          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-5 leading-[1.1] tracking-tighter">
            LP Farming
            <br />
            <span className="bg-gradient-to-r from-meteora-purple to-meteora-blue bg-clip-text text-transparent">
              Made Simple
            </span>
          </h1>

          <p className="text-gray-400 mb-10 max-w-md mx-auto leading-relaxed">
            Deposit SOL, let the AI agent find the best pools.
            Real-time monitoring, smart rebalancing, and auto fee collection.
          </p>

          <div className="flex justify-center mb-12">
            <WalletButton />
          </div>

          {/* Features */}
          <div className="grid grid-cols-3 gap-4 text-left">
            <div className="glass-card glass-card-hover rounded-2xl p-5 hover:scale-[1.02]">
              <div className="p-2 rounded-lg bg-meteora-blue/10 w-fit mb-3">
                <Brain size={20} className="text-meteora-blue" />
              </div>
              <h3 className="text-sm font-semibold mb-1">AI Selection</h3>
              <p className="text-xs text-gray-500 leading-relaxed">Analyzes volume, fees, momentum to pick optimal pools</p>
            </div>
            <div className="glass-card glass-card-hover rounded-2xl p-5 hover:scale-[1.02]">
              <div className="p-2 rounded-lg bg-green-400/10 w-fit mb-3">
                <TrendingUp size={20} className="text-green-400" />
              </div>
              <h3 className="text-sm font-semibold mb-1">Smart Rebalance</h3>
              <p className="text-xs text-gray-500 leading-relaxed">Alerts when out of range, one-click rebalance</p>
            </div>
            <div className="glass-card glass-card-hover rounded-2xl p-5 hover:scale-[1.02]">
              <div className="p-2 rounded-lg bg-meteora-purple/10 w-fit mb-3">
                <Shield size={20} className="text-meteora-purple" />
              </div>
              <h3 className="text-sm font-semibold mb-1">Self-Improving</h3>
              <p className="text-xs text-gray-500 leading-relaxed">Learning engine optimizes strategy over time</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
