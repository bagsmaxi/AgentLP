import { logger } from '../utils/logger';

let cachedSolPrice: number = 0;
let lastFetchTime: number = 0;
const CACHE_DURATION_MS = 60_000; // 1 minute

export async function getSolPrice(): Promise<number> {
  const now = Date.now();
  if (cachedSolPrice > 0 && now - lastFetchTime < CACHE_DURATION_MS) {
    return cachedSolPrice;
  }

  try {
    // Use CoinGecko free API for SOL price
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    const data = (await response.json()) as { solana: { usd: number } };
    cachedSolPrice = data.solana.usd;
    lastFetchTime = now;
    logger.info('SOL price fetched', { price: cachedSolPrice });
    return cachedSolPrice;
  } catch (err) {
    logger.error('Failed to fetch SOL price', { error: err });
    // Return last known price or a fallback
    return cachedSolPrice || 0;
  }
}
