/* Boot: database, scheduler, HTTP server. */

import http from 'node:http';
import { config } from './config.js';
import { handleRequest } from './api.js';
import { ensureRounds, refreshStatuses, currentRound, roundsNeedingSnapshot, takeSnapshot, phaseOf } from './rounds.js';
import { indexRound, finalizeRound } from './indexer.js';
import { updateFees, feesEnabled } from './fees.js';
import { queryOne, now } from './db.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);

let indexing = false;

async function tick() {
  if (indexing) return;
  indexing = true;
  try {
    ensureRounds();
    refreshStatuses();

    /* Holder snapshot, once per round, when registration opens. */
    for (const round of roundsNeedingSnapshot()) {
      const result = await takeSnapshot(round.id);
      log(`snapshot round ${round.number}:`, result.ok ? `${result.holders} eligible holders` : result.reason);
    }

    const round = currentRound();
    if (!round) return;
    const phase = phaseOf(round);

    /* Nothing to score until you start the round. */
    if (phase === 'registration') return;

    /* Keep the pot in step with the fees the coin is earning. */
    if (phase === 'trading') {
      const fees = await updateFees(round).catch((err) => {
        log('fee check failed:', err.message);
        return null;
      });
      if (fees?.counted) log(`round ${round.number}: +${fees.counted} fee payment(s), pot now $${fees.potUsd.toFixed(2)}`);
    }

    if (phase === 'trading') {
      const results = await indexRound(round);
      const errors = results.filter((r) => r.error);
      const scored = results.filter((r) => !r.skipped && !r.error).length;
      const quiet = results.filter((r) => r.skipped).length;
      log(
        `round ${round.number}: ${results.length} wallets — ${scored} rescored, ${quiet} unchanged` +
          (errors.length ? `, ${errors.length} errors` : ''),
      );
    }

    /* First pass after the clock runs out freezes the result. */
    if (phase === 'review' && round.status !== 'settled') {
      const frozen = queryOne(
        `SELECT COUNT(*) AS n FROM entries WHERE round_id = ? AND final_rank IS NOT NULL`,
        round.id,
      );
      if (!frozen?.n) {
        await indexRound(round); // final valuation: cash only
        const result = finalizeRound(round);
        log(`round ${round.number} finished:`, result);
      }
    }
  } catch (err) {
    log('tick failed:', err.message);
  } finally {
    indexing = false;
  }
}

ensureRounds();
const round = currentRound();
log(`FirstTX backend starting — round ${round?.number} (${phaseOf(round)})`);
log('Rounds are started by hand from the admin panel.');
if (!config.coinMint) log('WARNING: COIN_MINT is not set, so the $25 holding requirement is skipped.');
if (!config.adminToken) log('WARNING: ADMIN_TOKEN is not set, so admin endpoints are disabled.');
log(feesEnabled()
  ? `Pot is ${config.potPercent}% of fees arriving in ${config.feeWallet.slice(0, 6)}…${config.feeWallet.slice(-4)}.`
  : 'Pot is set by hand (FEE_WALLET / POT_PERCENT are not set).');

tick();
setInterval(tick, Math.max(30, config.indexIntervalSeconds) * 1000);

const server = http.createServer(handleRequest);
server.listen(config.port, () => log(`API listening on http://localhost:${config.port}`));

const shutdown = () => {
  log('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { tick, now };
