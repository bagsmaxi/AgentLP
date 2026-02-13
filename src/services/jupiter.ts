import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getConnection, serializeTransaction } from './solana';
import { config } from '../config';
import { logger } from '../utils/logger';

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT = config.tokens.SOL_MINT;

/**
 * Get a Jupiter swap quote for swapping a token to SOL.
 */
async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string, // raw token amount (lamport-scale)
  slippageBps: number = 100 // 1%
): Promise<any> {
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Build a Jupiter swap transaction from a quote.
 */
async function getSwapTransaction(
  quoteResponse: any,
  userPublicKey: string,
): Promise<string> {
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Jupiter swap tx failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { swapTransaction: string };
  return data.swapTransaction; // base64 encoded transaction
}

/**
 * Get the token balance for a specific mint in a wallet.
 * Returns the raw amount (lamport-scale).
 */
async function getTokenBalance(
  walletAddress: string,
  tokenMint: string,
): Promise<string> {
  const conn = getConnection();
  const wallet = new PublicKey(walletAddress);
  const mint = new PublicKey(tokenMint);

  // Get all token accounts for this mint
  const tokenAccounts = await conn.getTokenAccountsByOwner(wallet, { mint });

  if (tokenAccounts.value.length === 0) {
    return '0';
  }

  // Sum balances across all accounts for this mint
  let total = BigInt(0);
  for (const account of tokenAccounts.value) {
    const info = await conn.getTokenAccountBalance(account.pubkey);
    total += BigInt(info.value.amount);
  }

  return total.toString();
}

/**
 * Prepare a Jupiter swap transaction to convert a non-SOL token to SOL.
 *
 * Used after closing/withdrawing a position or claiming fees to
 * convert the non-SOL token portion to SOL (100% SOL rewards).
 *
 * Returns null if there's no token balance to swap.
 */
export async function prepareSwapToSol(params: {
  walletAddress: string;
  tokenMint: string;
  tokenAmount?: string; // if known, skip balance check
}): Promise<{
  serializedTx: string;
  inputAmount: string;
  expectedOutputSol: number;
} | null> {
  const { walletAddress, tokenMint } = params;

  // Skip if the token IS SOL
  if (tokenMint === SOL_MINT) {
    return null;
  }

  // Get the token balance to swap
  const amount = params.tokenAmount || await getTokenBalance(walletAddress, tokenMint);

  if (amount === '0' || !amount) {
    logger.info('No token balance to swap', { tokenMint, wallet: walletAddress });
    return null;
  }

  logger.info('Preparing Jupiter swap to SOL', {
    tokenMint,
    amount,
    wallet: walletAddress,
  });

  try {
    // Get quote
    const quote = await getQuote(tokenMint, SOL_MINT, amount);

    if (!quote || !quote.outAmount) {
      logger.warn('Jupiter quote returned no output', { tokenMint, amount });
      return null;
    }

    const expectedOutputSol = parseInt(quote.outAmount) / 1e9;

    // Skip tiny swaps (dust)
    if (expectedOutputSol < 0.000001) {
      logger.info('Token balance too small to swap', {
        tokenMint,
        expectedSol: expectedOutputSol,
      });
      return null;
    }

    // Get swap transaction
    const swapTxBase64 = await getSwapTransaction(quote, walletAddress);

    logger.info('Jupiter swap transaction prepared', {
      tokenMint,
      inputAmount: amount,
      expectedOutputSol: expectedOutputSol.toFixed(6),
    });

    return {
      serializedTx: swapTxBase64,
      inputAmount: amount,
      expectedOutputSol,
    };
  } catch (err) {
    logger.error('Jupiter swap preparation failed', {
      tokenMint,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Get the non-SOL token mint from a pool.
 */
export function getNonSolMint(mintX: string, mintY: string): string {
  if (mintX === SOL_MINT) return mintY;
  return mintX;
}
