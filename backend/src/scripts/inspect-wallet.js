/* `node src/scripts/inspect-wallet.js <address>` — values any wallet with the
   same code the leaderboard uses. Read-only; handy for spot checks. */

import { SOL_MINT, CASH_MINTS } from '../config.js';
import { getSolBalance, getTokenBalances } from '../solana.js';
import { valuePositions } from '../prices.js';

const address = process.argv[2];
if (!address) {
  console.error('usage: node src/scripts/inspect-wallet.js <address>');
  process.exit(1);
}

const [sol, tokens] = await Promise.all([getSolBalance(address), getTokenBalances(address)]);

const positions = [
  { mint: SOL_MINT, amount: sol, decimals: 9, raw: String(Math.round(sol * 1e9)) },
  ...tokens,
].filter((p) => p.amount > 0);

const { totalUsd, positions: valued } = await valuePositions(positions);
const cash = valued.filter((p) => CASH_MINTS.has(p.mint)).reduce((sum, p) => sum + p.usd, 0);

console.log(`wallet ${address}`);
console.log(`positions: ${valued.length}`);
for (const p of valued.sort((a, b) => b.usd - a.usd).slice(0, 15)) {
  console.log(
    `  ${p.mint.slice(0, 6)}…${p.mint.slice(-4)}  ${p.amount.toFixed(4).padStart(16)}  ` +
      `$${p.usd.toFixed(2).padStart(12)}  (${p.source})`,
  );
}
console.log(`\ntotal value      $${totalUsd.toFixed(2)}`);
console.log(`cash only        $${cash.toFixed(2)}   <- what counts at the end of a round`);
console.log(`solscan          https://solscan.io/account/${address}`);
