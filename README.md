# LPCLAW

AI-powered liquidity provision agent for [Meteora DLMM](https://www.meteora.ag/) on Solana.

Deposit SOL, let the AI find the best pools, optimize strategy, and manage your positions automatically.

## How It Works

### Assisted Mode
| Step | What Happens |
|------|-------------|
| 1. Connect wallet | Phantom / Solflare via wallet adapter |
| 2. Choose amount | Enter SOL amount to deposit |
| 3. AI picks pool | Claude AI analyzes pools by volume, fees, momentum, liquidity. Falls back to rule-based scoring |
| 4. Strategy optimization | Selects Spot/Curve/BidAsk strategy with momentum-aware bin ranges |
| 5. Single-sided deposit | SOL deposited on one side of the active bin via Meteora DLMM SDK |
| 6. Monitoring | Position monitor checks if price moves out of range |
| 7. Rebalance | One-click rebalance: close old position, open new at current price |
| 8. Fee claiming | Auto-claims accumulated swap fees when threshold is met |

### Degen Mode
Same flow but prioritizes highest APR and momentum over safety. Accepts higher-risk pools (memecoins, newer tokens).

## Architecture

```
├── src/                    # Express backend
│   ├── agent/              # Core agent logic
│   │   ├── pool-analyzer   # Pool scoring + caching
│   │   ├── strategy-optimizer # Bin range + strategy selection
│   │   ├── position-monitor   # Out-of-range detection
│   │   ├── rebalancer      # Close + reopen positions
│   │   ├── fee-claimer     # Auto fee collection
│   │   └── learning        # Strategy performance tracking
│   ├── services/
│   │   ├── meteora         # DLMM SDK wrapper
│   │   ├── openclaw        # Claude AI integration
│   │   ├── solana          # RPC + transaction helpers
│   │   └── price-feed      # SOL price feed
│   ├── routes/             # REST API endpoints
│   └── server.ts           # Express + WebSocket server
│
├── web/                    # Next.js frontend
│   ├── app/                # Pages (landing + dashboard)
│   ├── components/         # React components
│   │   ├── DepositForm     # SOL deposit with mode selection
│   │   ├── PoolRankings    # AI-ranked pool table
│   │   ├── PositionCard    # Position management (rebalance/withdraw)
│   │   ├── PositionsDashboard # Stats + position grid
│   │   └── NotificationBell   # Real-time alerts
│   └── lib/                # API client + React Query hooks
```

## Tech Stack

- **Backend**: Express, TypeScript, SQLite (better-sqlite3)
- **Frontend**: Next.js 14, Tailwind CSS, React Query
- **Solana**: @solana/web3.js, @meteora-ag/dlmm, wallet-adapter
- **AI**: Claude CLI (uses your Pro/Max subscription)

## Setup

### Prerequisites
- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated
- Solana RPC URL (Helius, Quicknode, etc.)

### Backend
```bash
npm install
cp .env.example .env
# Edit .env with your RPC URL and config
npx ts-node src/server.ts
```

### Frontend
```bash
cd web
npm install
cp .env.local.example .env.local
# Edit .env.local with your RPC URL
npm run dev
```

### Environment Variables

**Backend (.env)**
```
SOLANA_RPC_URL=https://your-rpc-url
PORT=3001
OPENCLAW_ENABLED=true
```

**Frontend (web/.env.local)**
```
NEXT_PUBLIC_SOLANA_RPC_URL=https://your-rpc-url
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/pools/rankings | AI-ranked pools with scores |
| POST | /api/agent/deposit | Create LP position |
| GET | /api/positions?wallet=... | User's positions with fees |
| POST | /api/positions/:id/close | Close position |
| POST | /api/positions/:id/rebalance | Rebalance to current range |
| GET | /api/analytics?wallet=... | Performance summary |
| GET | /api/notifications?wallet=... | Alerts (out of range, etc.) |
| GET | /api/health | Health check |

## Key Features

- **AI Pool Selection**: Claude analyzes volume, fees, liquidity, and momentum to pick optimal pools
- **Momentum-Aware Ranges**: Wider bin ranges for trending tokens (+40% for hot, +20% for rising)
- **Single-Sided SOL**: Deposit only SOL, no need to acquire the paired token
- **Real-Time Monitoring**: WebSocket updates for position status changes
- **Smart Rebalancing**: Detects out-of-range positions, one-click rebalance via wallet
- **Fee Tracking**: Accurate claimable fee calculation from on-chain position bin data
- **Glassmorphism UI**: Clean, professional dark theme with subtle animations
