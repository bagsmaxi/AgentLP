import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { initDatabase, closeDatabase, prisma } from './db';
import { poolsRouter } from './routes/pools';
import { positionsRouter } from './routes/positions';
import { agentRouter } from './routes/agent';
import { analyticsRouter } from './routes/analytics';
import { notificationsRouter } from './routes/notifications';
import { getSolBalance } from './services/solana';
import { getDepositFeeSol } from './services/fees';
import { startPoolCacheRefresh } from './agent/pool-analyzer';
import { startMonitoring } from './agent/position-monitor';
import { logger } from './utils/logger';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/pools', poolsRouter);
app.use('/api/positions', positionsRouter);
app.use('/api/agent', agentRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/notifications', notificationsRouter);

// Wallet balance endpoint
app.get('/api/balance/:wallet', async (req, res) => {
  try {
    const balance = await getSolBalance(req.params.wallet);
    res.json({ success: true, data: { balance } });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// Fee info endpoint
app.get('/api/fees/info', async (_req, res) => {
  try {
    const depositFeeSol = await getDepositFeeSol();
    res.json({
      success: true,
      data: {
        depositFeeSol: Math.round(depositFeeSol * 1e9) / 1e9,
        depositFeeUsd: 0.50,
        performanceFeePercent: 10,
        treasuryWallet: 'GrXgQb2KviNMzTxonV6zTwfMy61a3Ww7ZAJB82b4NAp',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create HTTP server
const server = http.createServer(app);

// WebSocket for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Map<string, Set<WebSocket>>(); // wallet -> clients

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://localhost`);
  const wallet = url.searchParams.get('wallet');

  if (wallet) {
    if (!wsClients.has(wallet)) {
      wsClients.set(wallet, new Set());
    }
    wsClients.get(wallet)!.add(ws);
    logger.info('WebSocket client connected', { wallet });

    ws.on('close', () => {
      wsClients.get(wallet)?.delete(ws);
      if (wsClients.get(wallet)?.size === 0) {
        wsClients.delete(wallet);
      }
    });
  }
});

/**
 * Broadcast an update to all WebSocket clients for a specific wallet
 */
export function broadcastUpdate(walletAddress: string, event: string, data: any) {
  const clients = wsClients.get(walletAddress);
  if (!clients) return;

  const message = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Resume position monitoring for all wallets that have active positions.
 * Called on server startup so monitoring survives restarts.
 */
async function resumeMonitoringForActivePositions() {
  try {
    const activePositions = await prisma.position.findMany({
      where: { status: 'active' },
      select: { walletAddress: true },
      distinct: ['walletAddress'],
    });

    if (activePositions.length === 0) return;

    for (const { walletAddress } of activePositions) {
      startMonitoring(walletAddress);
    }

    logger.info('Resumed monitoring for active wallets', {
      walletCount: activePositions.length,
    });
  } catch (err) {
    logger.error('Failed to resume monitoring', { error: (err as Error).message });
  }
}

// Startup
async function start() {
  try {
    await initDatabase();
    logger.info('Database connected');

    // Pre-warm pool cache in background
    startPoolCacheRefresh();

    // Auto-resume monitoring for all wallets with active positions
    resumeMonitoringForActivePositions();

    server.listen(config.server.port, () => {
      logger.info(`LPCLAW server running on port ${config.server.port}`);
      logger.info(`WebSocket available at ws://localhost:${config.server.port}/ws`);
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  wss.close();
  server.close();
  await closeDatabase();
  process.exit(0);
});

start();
