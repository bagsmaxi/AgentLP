import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'LPCLAW - AI-Powered Meteora LP Farming',
  description: 'Automated liquidity provision on Meteora DLMM powered by AI',
  icons: {
    icon: '/logo.png',
    apple: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-dark-900 text-white">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
