import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.solana.wsUrl,
    });
    logger.info('Solana connection established', { rpc: config.solana.rpcUrl });
  }
  return connection;
}

export function loadKeypair(path?: string): Keypair | null {
  const keypairPath = path || config.solana.keypairPath;
  if (!keypairPath) return null;

  try {
    const raw = fs.readFileSync(keypairPath, 'utf-8');
    const secretKey = Uint8Array.from(JSON.parse(raw));
    const keypair = Keypair.fromSecretKey(secretKey);
    logger.info('Keypair loaded', { publicKey: keypair.publicKey.toBase58() });
    return keypair;
  } catch (err) {
    logger.error('Failed to load keypair', { path: keypairPath, error: err });
    return null;
  }
}

export async function signAndSendTransaction(
  tx: Transaction,
  keypair: Keypair
): Promise<string> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;

  const signature = await sendAndConfirmTransaction(conn, tx, [keypair], {
    commitment: 'confirmed',
    maxRetries: 3,
  });
  logger.info('Transaction sent', { signature });
  return signature;
}

export function serializeTransaction(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}

export async function getSolBalance(walletAddress: string): Promise<number> {
  const conn = getConnection();
  const pubkey = new PublicKey(walletAddress);
  const balance = await conn.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL;
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}
