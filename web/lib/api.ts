const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'API request failed');
  }
  return json.data;
}

// Pool endpoints
export const fetchPools = (limit = 10, mode: 'assisted' | 'degen' = 'assisted') =>
  apiFetch<any[]>(`/api/pools?limit=${limit}&mode=${mode}`);

export const fetchPoolDetail = (address: string) =>
  apiFetch<any>(`/api/pools/${address}`);

// Position endpoints
export const fetchPositions = (wallet: string) =>
  apiFetch<any[]>(`/api/positions?wallet=${wallet}`);

export const createPosition = (body: {
  walletAddress: string;
  poolAddress: string;
  solAmount: number;
}) => apiFetch<any>('/api/positions/create', {
  method: 'POST',
  body: JSON.stringify(body),
});

export const confirmPosition = (body: any) =>
  apiFetch<void>('/api/positions/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  });

// Agent endpoints
export const startAgent = (body: {
  walletAddress: string;
  mode: 'assisted' | 'degen';
  solAmount: number;
  tokenMint?: string;
}) => apiFetch<any>('/api/agent/start', {
  method: 'POST',
  body: JSON.stringify(body),
});

export const stopAgent = (sessionId: string) =>
  apiFetch<any>('/api/agent/stop', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });

export const fetchSessions = (wallet: string) =>
  apiFetch<any[]>(`/api/agent/sessions?wallet=${wallet}`);

// Balance
export const fetchBalance = (wallet: string) =>
  apiFetch<{ balance: number }>(`/api/balance/${wallet}`);

// Analytics
export const fetchAnalytics = (wallet: string) =>
  apiFetch<any>(`/api/analytics?wallet=${wallet}`);

export const fetchLearningInsights = () =>
  apiFetch<any>('/api/analytics/learning');

// Close position - get serialized close transaction(s)
export const closePosition = (positionId: string, walletAddress: string) =>
  apiFetch<{
    serializedTxs: string[];
    blockhash: string;
    lastValidBlockHeight: number;
    alreadyClosed?: boolean;
  }>(`/api/positions/${positionId}/close`, {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
  });

// Confirm close - mark position as closed in DB after signing
export const confirmClosePosition = (positionId: string, walletAddress: string) =>
  apiFetch<void>(`/api/positions/${positionId}/close-confirm`, {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
  });

// Rebalance - prepare close + new position txs
export const rebalancePosition = (positionId: string, walletAddress: string) =>
  apiFetch<{
    closeTxs: string[];
    closeTxBlockhash: string;
    closeTxLastValidBlockHeight: number;
    newPositionTx: string;
    newPositionPubkey: string;
    newPositionStrategy: any;
    newPositionBlockhash: string;
    newPositionLastValidBlockHeight: number;
    poolAddress: string;
    poolName: string;
    switchedPool: boolean;
  }>(`/api/positions/${positionId}/rebalance`, {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
  });

// Confirm rebalance
export const confirmRebalance = (positionId: string, body: {
  walletAddress: string;
  newPositionPubkey: string;
  poolAddress: string;
  poolName: string;
  strategy: any;
  solDeposited: number;
}) => apiFetch<void>(`/api/positions/${positionId}/rebalance-confirm`, {
  method: 'POST',
  body: JSON.stringify(body),
});

// Notifications
export const fetchNotifications = (wallet: string, unreadOnly = false) =>
  apiFetch<any[]>(`/api/notifications?wallet=${wallet}${unreadOnly ? '&unreadOnly=true' : ''}`);

export const fetchUnreadCount = (wallet: string) =>
  apiFetch<{ count: number }>('/api/notifications/unread-count?wallet=' + wallet);

export const markNotificationRead = (id: string) =>
  apiFetch<void>(`/api/notifications/${id}/read`, { method: 'POST' });

export const markAllNotificationsRead = (walletAddress: string) =>
  apiFetch<void>('/api/notifications/read-all', {
    method: 'POST',
    body: JSON.stringify({ walletAddress }),
  });

// Fee info
export const fetchFeeInfo = () =>
  apiFetch<{
    depositFeeSol: number;
    depositFeeUsd: number;
    performanceFeePercent: number;
    treasuryWallet: string;
  }>('/api/fees/info');
