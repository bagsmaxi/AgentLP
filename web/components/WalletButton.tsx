'use client';

import dynamic from 'next/dynamic';

// Dynamic import to avoid SSR issues with wallet adapter
const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then(mod => mod.WalletMultiButton),
  { ssr: false }
);

export function WalletButton() {
  return <WalletMultiButton className="!bg-gradient-to-r !from-meteora-purple !to-meteora-blue !rounded-xl !px-6 !py-3 !text-sm !font-semibold btn-glow" />;
}
