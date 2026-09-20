/* `node src/scripts/replay-wallet.js [address] [count]`

   Replays real mainnet transactions through the same classifier the indexer
   uses, and prints what each one would count as: a trade, a deposit or a
   withdrawal. With no address it picks a wallet that just swapped on Jupiter,
   so it is always testing against live trading activity. */

import { config, SOL_MINT } from '../config.js';
import { rpc, getSignaturesSince, getParsedTransaction } from '../solana.js';
import { getPrices } from '../prices.js';
import { classifyTransaction } from '../indexer.js';

const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

let address = process.argv[2];
const count = Number(process.argv[3] || 12);

if (!address) {
  const recent = await rpc('getSignaturesForAddress', [JUPITER, { limit: 12 }]);
  for (const item of recent || []) {
    const tx = await getParsedTransaction(item.signature);
    const keys = tx?.transaction?.message?.accountKeys || [];
    const payer = keys[0] && (typeof keys[0] === 'string' ? keys[0] : keys[0].pubkey);
    if (payer) {
      address = payer;
      break;
    }
  }
  if (!address) {
    console.error('could not find a recent swapping wallet');
    process.exit(1);
  }
  console.log(`picked a wallet that just swapped on Jupiter: ${address}\n`);
}

const signatures = await getSignaturesSince(address, null, count);
console.log(`replaying ${signatures.length} transactions for ${address}\n`);

let trades = 0;
let deposits = 0;
let withdrawals = 0;
let dust = 0;

for (const item of signatures.reverse()) {
  const tx = await getParsedTransaction(item.signature);
  if (!tx) continue;
  if (tx.meta?.err) {
    console.log(`  ${item.signature.slice(0, 8)}…  failed tx, ignored`);
    continue;
  }
  const moves = classifyTransaction(tx, address);
  let label;
  if (moves.isSwap) {
    label = 'TRADE';
    trades += 1;
  } else if (moves.inbound.length) {
    label = `DEPOSIT  ${moves.inbound.map((m) => m.amount.toFixed(4) + ' of ' + (m.mint || 'SOL').slice(0, 6)).join(', ')}`;
    deposits += moves.inbound.length;
  } else if (moves.outbound.length) {
    /* Value the outflow the way the indexer does, so fees and tips are not
       mistaken for withdrawals. */
    const prices = await getPrices(moves.outbound.map((m) => m.mint || SOL_MINT));
    const usd = moves.outbound.reduce((sum, m) => sum + (prices.get(m.mint || SOL_MINT) ?? 0) * m.amount, 0);
    if (usd >= config.dustTransferUsd) {
      label = `WITHDRAW $${usd.toFixed(2)}`;
      withdrawals += 1;
    } else {
      label = `fee or tip $${usd.toFixed(4)} (ignored)`;
      dust += 1;
    }
  } else {
    label = 'no value movement (ignored)';
  }
  console.log(`  ${item.signature.slice(0, 8)}…  ${label}`);
}

console.log(`\ntrades: ${trades}   deposits: ${deposits}   withdrawals: ${withdrawals}   fees/tips ignored: ${dust}`);
console.log(`solscan: https://solscan.io/account/${address}`);
