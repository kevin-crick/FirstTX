/* Round lifecycle.

   registration opens (snapshot)  -> opens_at - REGISTRATION_LEAD_HOURS
   round starts / deposits open   -> opens_at        (00:00 UTC)
   deposits close                 -> + DEPOSIT_WINDOW_HOURS
   round ends                     -> opens_at + 24h
   then: review -> settled
*/

import { config } from './config.js';
import { queryOne, queryAll, run, now } from './db.js';
import { getMintHolders, getMintHoldersViaDas } from './solana.js';
import { getPrices } from './prices.js';

const DAY = 86_400;

/** UTC timestamp of the round start for the day `date` falls in. */
function startOfRoundUtc(date) {
  const d = new Date(date);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), config.roundStartHour, 0, 0) / 1000);
}

function buildRound(number, opensAt) {
  return {
    number,
    snapshot_at: opensAt - config.registrationLeadHours * 3600,
    opens_at: opensAt,
    deposit_closes_at: opensAt + config.depositWindowHours * 3600,
    ends_at: opensAt + DAY,
  };
}

function insertRound(round) {
  run(
    `INSERT OR IGNORE INTO rounds
       (number, snapshot_at, opens_at, deposit_closes_at, ends_at, status, coin_mint, created_at)
     VALUES (?, ?, ?, ?, ?, 'upcoming', ?, ?)`,
    round.number,
    round.snapshot_at,
    round.opens_at,
    round.deposit_closes_at,
    round.ends_at,
    config.coinMint || null,
    now(),
  );
  return queryOne('SELECT * FROM rounds WHERE number = ?', round.number);
}

/** Make sure today's and tomorrow's rounds exist, and keep statuses current. */
export function ensureRounds() {
  const nowTs = now();
  let todayStart = startOfRoundUtc(nowTs * 1000);
  if (todayStart > nowTs) todayStart -= DAY; // before the daily start hour

  const last = queryOne('SELECT number, opens_at FROM rounds ORDER BY number DESC LIMIT 1');
  let number = last ? last.number : 1;
  let opensAt = last ? last.opens_at : todayStart;

  if (!last) insertRound(buildRound(number, opensAt));

  /* Fill forward until tomorrow's round exists. */
  while (opensAt < todayStart + DAY) {
    number += 1;
    opensAt += DAY;
    insertRound(buildRound(number, opensAt));
  }

  refreshStatuses();
  return currentRound();
}

export function refreshStatuses() {
  const nowTs = now();
  run(`UPDATE rounds SET status = 'registration' WHERE status = 'upcoming'  AND ? >= snapshot_at AND ? < opens_at`, nowTs, nowTs);
  run(`UPDATE rounds SET status = 'live'         WHERE status IN ('upcoming','registration') AND ? >= opens_at AND ? < ends_at`, nowTs, nowTs);
  run(`UPDATE rounds SET status = 'review'       WHERE status = 'live'      AND ? >= ends_at`, nowTs);
}

/** The round people are currently looking at: the live one, else the next one. */
export function currentRound() {
  const nowTs = now();
  return (
    queryOne(`SELECT * FROM rounds WHERE ? >= opens_at AND ? < ends_at ORDER BY number DESC LIMIT 1`, nowTs, nowTs) ||
    queryOne(`SELECT * FROM rounds WHERE opens_at > ? ORDER BY number ASC LIMIT 1`, nowTs) ||
    queryOne(`SELECT * FROM rounds ORDER BY number DESC LIMIT 1`)
  );
}

/** The round currently accepting registrations, if any. */
export function registrationRound() {
  const nowTs = now();
  return queryOne(
    `SELECT * FROM rounds
      WHERE ? >= snapshot_at AND ? < deposit_closes_at
      ORDER BY number ASC LIMIT 1`,
    nowTs,
    nowTs,
  );
}

export function phaseOf(round, nowTs = now()) {
  if (!round) return 'none';
  if (nowTs < round.snapshot_at) return 'upcoming';
  if (nowTs < round.opens_at) return 'registration';
  if (nowTs < round.deposit_closes_at) return 'deposit-window';
  if (nowTs < round.ends_at) return 'trading';
  if (round.status === 'settled') return 'settled';
  return 'review';
}

/**
 * Take the holder snapshot for a round: who held the coin, and how much,
 * at the moment registration opened.
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
    /* Helius has a purpose-built holder call; everything else falls back to
       scanning the token program. */
    holders = /helius/i.test(config.rpcUrl)
      ? await getMintHoldersViaDas(config.coinMint)
      : await getMintHolders(config.coinMint);
  } catch (err) {
    run(`UPDATE rounds SET snapshot_status = 'failed' WHERE id = ?`, roundId);
    return { ok: false, reason: `snapshot call failed: ${err.message}. A paid RPC endpoint is needed for this.` };
  }

  const prices = await getPrices([config.coinMint]);
  const price = prices.get(config.coinMint) ?? 0;

  run('DELETE FROM snapshot_holders WHERE round_id = ?', roundId);
  const insert = `INSERT OR REPLACE INTO snapshot_holders (round_id, owner, ui_amount, usd_value) VALUES (?, ?, ?, ?)`;
  let kept = 0;
  for (const [owner, amount] of holders) {
    const usd = amount * price;
    if (usd < config.minHoldUsd) continue; // only eligible holders are worth storing
    run(insert, roundId, owner, amount, usd);
    kept += 1;
  }

  run(`UPDATE rounds SET snapshot_status = 'done', snapshot_holders = ?, coin_mint = ? WHERE id = ?`, kept, config.coinMint, roundId);
  return { ok: true, holders: kept, price };
}

export function holderSnapshotEntry(roundId, owner) {
  return queryOne('SELECT * FROM snapshot_holders WHERE round_id = ? AND owner = ?', roundId, owner);
}

export function roundsNeedingSnapshot() {
  const nowTs = now();
  return queryAll(
    `SELECT * FROM rounds WHERE snapshot_status = 'pending' AND ? >= snapshot_at AND ? < ends_at`,
    nowTs,
    nowTs,
  );
}
