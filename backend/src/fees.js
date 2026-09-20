/* The pot, worked out from the coin's fees.

   Creator fees land in a wallet you control. While a round is running we add
   up everything that arrives in that wallet, and the pot is your chosen share
   of it. Counting arrivals rather than the balance means moving the fees out
   mid-round does not shrink the pot.

   Set FEE_WALLET and POT_PERCENT to switch this on. Without them the pot stays
   whatever you type into the admin page. */

import { config, SOL_MINT, CASH_MINTS } from './config.js';
import { queryOne, run, now } from './db.js';
import { getSignaturesSince, getParsedTransaction } from './solana.js';
import { getPrices } from './prices.js';
import { classifyTransaction } from './indexer.js';

const MAX_TX_PER_PASS = 200;

export function feesEnabled() {
  return Boolean(config.feeWallet) && config.potPercent > 0;
}

/**
 * Add up fees that arrived since the last pass and update the round's pot.
 * Returns { feesUsd, potUsd, counted } or null when fee tracking is off.
 */
export async function updateFees(round) {
  if (!feesEnabled() || !round) return null;
  if (round.status !== 'live') return null;

  const signatures = (await getSignaturesSince(config.feeWallet, round.fee_cursor, MAX_TX_PER_PASS)).reverse();

  let added = 0;
  let counted = 0;
  let newest = round.fee_cursor;

  for (const item of signatures) {
    const tx = await getParsedTransaction(item.signature);
    newest = item.signature;
    if (!tx || tx.meta?.err) continue;

    const blockTime = tx.blockTime ?? item.blockTime ?? now();
    /* Only fees earned during this round count towards this round's pot. */
    if (round.opens_at && blockTime < round.opens_at) continue;

    const moves = classifyTransaction(tx, config.feeWallet);
    if (moves.isSwap) continue;

    for (const move of moves.inbound) {
      const mint = move.mint || SOL_MINT;
      if (mint !== SOL_MINT && !CASH_MINTS.has(mint)) continue; // ignore token dust
      const prices = await getPrices([mint]);
      const usd = (prices.get(mint) ?? 0) * move.amount;
      if (usd < config.dustTransferUsd) continue;
      added += usd;
      counted += 1;
    }
  }

  const feesUsd = (round.fees_usd ?? 0) + added;
  const potUsd = round.pot_source === 'auto' ? (feesUsd * config.potPercent) / 100 : round.pot_usd;

  run(
    'UPDATE rounds SET fees_usd = ?, fee_cursor = ?, pot_usd = ? WHERE id = ?',
    feesUsd,
    newest,
    potUsd,
    round.id,
  );

  return { feesUsd, potUsd, counted };
}

/** Start counting from now, so a new round does not inherit old fees. */
export async function startFeeTracking(round) {
  if (!feesEnabled() || !round) return;
  const latest = await getSignaturesSince(config.feeWallet, null, 1);
  run(
    `UPDATE rounds SET fee_cursor = ?, fees_usd = 0, pot_usd = 0, pot_source = 'auto' WHERE id = ?`,
    latest[0]?.signature ?? null,
    round.id,
  );
}

export function feeSummary(round) {
  return {
    enabled: feesEnabled(),
    wallet: config.feeWallet || null,
    percent: config.potPercent,
    feesUsd: round?.fees_usd ?? 0,
    source: round?.pot_source ?? 'manual',
  };
}

export { queryOne };
