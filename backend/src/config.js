import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/* Minimal .env loader: KEY=value, # comments, no quotes required. */
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const num = (key, fallback) => {
  const raw = process.env[key];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  coinMint: (process.env.COIN_MINT || '').trim(),

  /* Where the coin's creator fees arrive, and how much of them goes into the
     pot. Leave the wallet blank to set the pot by hand instead. */
  feeWallet: (process.env.FEE_WALLET || '').trim(),
  potPercent: num('POT_PERCENT', 0),

  minHoldUsd: num('MIN_HOLD_USD', 25),
  depositCapUsd: num('DEPOSIT_CAP_USD', 1000),
  /* There is no deposit window. The first money into a wallet is its starting
     balance, and top-ups afterwards are flagged for the manual review.
     Funding split across a few transactions within this many seconds counts
     as one deposit. */
  depositGraceSeconds: num('DEPOSIT_GRACE_SECONDS', 900),

  port: num('PORT', 8787),
  /* Browsers send an origin with no trailing slash and no path, so accept
     whatever shape the value was pasted in and normalise it. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  adminToken: process.env.ADMIN_TOKEN || '',

  /* How often wallets are checked for new activity. */
  indexIntervalSeconds: num('INDEX_INTERVAL_SECONDS', 60),
  /* A wallet with no new transactions is still re-priced this often, so a
     position moving in the market updates even when nobody is trading.
     Checking for activity costs one call; re-pricing costs several, so these
     are deliberately different. */
  revalueIntervalSeconds: num('REVALUE_INTERVAL_SECONDS', 300),
  /* Write-endpoint rate limit per IP per minute. Raise it only for testing. */
  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 10),

  /* Transfers smaller than this are treated as network costs — priority fees,
     validator tips, rent — not as deposits or withdrawals. Traders pay these
     constantly, and flagging them would disqualify honest players. */
  dustTransferUsd: num('DUST_TRANSFER_USD', 2),
  /* Total value that may leak out in dust before it stops looking like fees. */
  dustOutflowBudgetUsd: num('DUST_OUTFLOW_BUDGET_USD', 25),

  dbPath: path.join(ROOT, 'data', 'firsttx.db'),
};

/* Well-known mints. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const STABLES = new Set([USDC_MINT, USDT_MINT]);

/* Counted as cash at the end of a round. */
export const CASH_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
