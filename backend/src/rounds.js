/* Round lifecycle — manually controlled.

   You decide when things happen, from the admin panel:

     create   -> status 'registration'. Holder snapshot is taken now, and
                 people can enter. No clock is running.
     start    -> status 'live'. The 24 hour clock starts at that moment, and
                 the deposit window opens for the first hour.
     (auto)   -> 24 hours later the round flips to 'review' by itself and the
                 final scores are frozen.
     end      -> same thing, early, if you want to stop a round sooner.

   Nothing is scheduled by the calendar; a round only exists because you made
   one, and only runs because you pressed start. */

import { config } from './config.js';
import { queryOne, queryAll, run, now } from './db.js';
import { getMintHolders, getMintHoldersViaDas } from './solana.js';
import { getPrices } from './prices.js';

const DAY = 86_400;

/* ------------------------------------------------------------- lifecycle */

/** Open registration for a new round. Fails if one is already open. */
export function createRound() {
  refreshStatuses(); // a round whose clock has run out is no longer live
  const open = queryOne(`SELECT * FROM rounds WHERE status = 'registration' ORDER BY number DESC LIMIT 1`);
  if (open) return { ok: false, reason: `round ${open.number} is already open for registration`, round: open };

  const live = queryOne(`SELECT * FROM rounds WHERE status = 'live' ORDER BY number DESC LIMIT 1`);
  if (live) return { ok: false, reason: `round ${live.number} is still running`, round: live };

  const last = queryOne('SELECT number FROM rounds ORDER BY number DESC LIMIT 1');
  const number = (last?.number ?? 0) + 1;

  run(
    `INSERT INTO rounds (number, snapshot_at, opens_at, deposit_closes_at, ends_at, status, coin_mint, created_at)
     VALUES (?, ?, 0, 0, 0, 'registration', ?, ?)`,
    number,
    now(),
    config.coinMint || null,
    now(),
  );

  return { ok: true, round: queryOne('SELECT * FROM rounds WHERE number = ?', number) };
}

/** Start the open round: 24 hours from this moment. */
export function startRound(hours = 24) {
  refreshStatuses();
  const round = queryOne(`SELECT * FROM rounds WHERE status = 'registration' ORDER BY number DESC LIMIT 1`);
  if (!round) return { ok: false, reason: 'no round is open for registration' };

  /* Two rounds running at once would split the field and the pot. */
  const live = queryOne(`SELECT number FROM rounds WHERE status = 'live' ORDER BY number DESC LIMIT 1`);
  if (live) return { ok: false, reason: `round ${live.number} is still running — end it first` };

  const startedAt = now();
  run(
    `UPDATE rounds SET status = 'live', opens_at = ?, deposit_closes_at = 0, ends_at = ? WHERE id = ?`,
    startedAt,
    startedAt + Math.round(hours * 3600),
    round.id,
  );

  return { ok: true, round: queryOne('SELECT * FROM rounds WHERE id = ?', round.id) };
}

/** Stop a running round now, instead of waiting for the clock. */
export function endRound() {
  const round = queryOne(`SELECT * FROM rounds WHERE status = 'live' ORDER BY number DESC LIMIT 1`);
  if (!round) return { ok: false, reason: 'no round is running' };
  run(`UPDATE rounds SET ends_at = ? WHERE id = ?`, now(), round.id);
  return { ok: true, round: queryOne('SELECT * FROM rounds WHERE id = ?', round.id) };
}

/** Flip a finished round to review. Called on every indexer pass. */
export function refreshStatuses() {
  run(`UPDATE rounds SET status = 'review' WHERE status = 'live' AND ends_at > 0 AND ? >= ends_at`, now());
}

/* --------------------------------------------------------------- lookups */

/** The round the site should show: the running one, else the one taking entries. */
export function currentRound() {
  return (
    queryOne(`SELECT * FROM rounds WHERE status = 'live' ORDER BY number DESC LIMIT 1`) ||
    queryOne(`SELECT * FROM rounds WHERE status = 'registration' ORDER BY number DESC LIMIT 1`) ||
    queryOne(`SELECT * FROM rounds ORDER BY number DESC LIMIT 1`)
  );
}

/**
 * The round accepting entries: one open for registration, or a round that is
 * still running. Latecomers are welcome — they simply have less of the 24
 * hours left, and their own deposit window starts when they enter.
 */
export function registrationRound() {
  const open = queryOne(`SELECT * FROM rounds WHERE status = 'registration' ORDER BY number DESC LIMIT 1`);
  if (open) return open;
  return queryOne(
    `SELECT * FROM rounds WHERE status = 'live' AND ends_at > ? ORDER BY number DESC LIMIT 1`,
    now(),
  );
}

export function phaseOf(round, nowTs = now()) {
  if (!round) return 'none';
  if (round.status === 'registration') return 'registration';
  if (round.status === 'settled') return 'settled';
  if (round.status === 'review') return 'review';
  if (round.status === 'live') {
    if (round.ends_at > 0 && nowTs >= round.ends_at) return 'review';
    return 'trading';
  }
  return round.status;
}

/** Make sure there is at least one round to look at on a brand-new database. */
export function ensureRounds() {
  const any = queryOne('SELECT id FROM rounds LIMIT 1');
  if (!any) createRound();
  refreshStatuses();
  return currentRound();
}

/* -------------------------------------------------------------- snapshot */

/**
 * Who held the coin, and how much, at the moment registration opened.
 * Taken once per round, when the round is created.
 */
export async function takeSnapshot(roundId) {
  const round = queryOne('SELECT * FROM rounds WHERE id = ?', roundId);
  if (!round) throw new Error('round not found');
  if (!config.coinMint) {
    run(`UPDATE rounds SET snapshot_status = 'skipped-no-mint' WHERE id = ?`, roundId);
    return { ok: false, reason: 'COIN_MINT is not set' };
  }
  if (round.snapshot_status === 'done') return { ok: true, holders: round.snapshot_holders, cached: true };

  let holders;
  try {
    holders = /helius/i.test(config.rpcUrl)
      ? await getMintHoldersViaDas(config.coinMint)
      : await getMintHolders(config.coinMint);
  } catch (err) {
    run(`UPDATE rounds SET snapshot_status = 'failed' WHERE id = ?`, roundId);
    return { ok: false, reason: `snapshot call failed: ${err.message}` };
  }

  const prices = await getPrices([config.coinMint]);
  const price = prices.get(config.coinMint) ?? 0;

  run('DELETE FROM snapshot_holders WHERE round_id = ?', roundId);
  const insert = `INSERT OR REPLACE INTO snapshot_holders (round_id, owner, ui_amount, usd_value) VALUES (?, ?, ?, ?)`;
  let kept = 0;
  for (const [owner, amount] of holders) {
    const usd = amount * price;
    if (usd < config.minHoldUsd) continue;
    run(insert, roundId, owner, amount, usd);
    kept += 1;
  }

  run(`UPDATE rounds SET snapshot_status = 'done', snapshot_holders = ?, coin_mint = ? WHERE id = ?`, kept, config.coinMint, roundId);
  return { ok: true, holders: kept, price };
}

export function holderSnapshotEntry(roundId, owner) {
  return queryOne('SELECT * FROM snapshot_holders WHERE round_id = ? AND owner = ?', roundId, owner);
}

/** Rounds open for registration whose snapshot has not been taken yet. */
export function roundsNeedingSnapshot() {
  return queryAll(`SELECT * FROM rounds WHERE snapshot_status = 'pending' AND status IN ('registration', 'live')`);
}

export { DAY };
