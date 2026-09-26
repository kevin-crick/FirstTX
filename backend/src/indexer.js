/* The indexer.

   For every active entry it:
     1. reads new transactions since the last pass,
     2. classifies inbound / outbound transfers and counts swaps,
     3. records rule breaks (extra deposits, withdrawals, over the cap),
     4. re-values the wallet and writes PnL.

   Deposits set the baseline; everything after is measured against it. */

import { config, SOL_MINT, CASH_MINTS } from './config.js';
import { queryAll, queryOne, run, now } from './db.js';
import { getSignaturesSince, getParsedTransaction, getSolBalance, getTokenBalances } from './solana.js';
import { getSolPrice, getPrices, valuePositions } from './prices.js';
import { phaseOf } from './rounds.js';

const MAX_TX_PER_PASS = 200;

/* ---------------------------------------------------------------- transfers */

/**
 * Work out what a transaction did to this wallet.
 * Returns { inbound: [...], outbound: [...], isSwap, feePayer }
 */
function classifyTransaction(tx, wallet) {
  const result = { inbound: [], outbound: [], isSwap: false, feePayer: null, blockTime: tx?.blockTime ?? null };
  const message = tx?.transaction?.message;
  if (!message) return result;

  const accountKeys = (message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  result.feePayer = accountKeys[0] ?? null;
  const walletSigns = (message.accountKeys || []).some(
    (k) => typeof k === 'object' && k.pubkey === wallet && k.signer,
  );

  const instructions = [
    ...(message.instructions || []),
    ...((tx.meta?.innerInstructions || []).flatMap((i) => i.instructions || [])),
  ];

  let sawTokenIn = false;
  let sawTokenOut = false;

  for (const ix of instructions) {
    const parsed = ix.parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    const type = parsed.type;
    const info = parsed.info || {};

    if (ix.program === 'system' && (type === 'transfer' || type === 'transferWithSeed')) {
      const lamports = Number(info.lamports ?? 0);
      if (!lamports) continue;
      if (info.destination === wallet && info.source !== wallet) {
        result.inbound.push({ mint: SOL_MINT, amount: lamports / 1e9, counterparty: info.source });
      } else if (info.source === wallet && info.destination !== wallet) {
        result.outbound.push({ mint: SOL_MINT, amount: lamports / 1e9, counterparty: info.destination });
      }
      continue;
    }

    if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') &&
        (type === 'transfer' || type === 'transferChecked')) {
      const amount = Number(info.tokenAmount?.uiAmount ?? (info.amount ? Number(info.amount) : 0));
      const mint = info.mint || null;
      const fromOwner = info.authority || info.multisigAuthority || null;
      const toOwner = info.destinationOwner || null;

      /* Owners are not always present in parsed data; fall back to the
         signer test, which is enough for the direction. */
      if (toOwner === wallet || (!toOwner && !walletSigns)) {
        sawTokenIn = true;
        result.inbound.push({ mint, amount, counterparty: fromOwner, uncertain: !toOwner });
      } else if (fromOwner === wallet || (!fromOwner && walletSigns)) {
        sawTokenOut = true;
        result.outbound.push({ mint, amount, counterparty: toOwner, uncertain: !fromOwner });
      }
    }
  }

  /* A swap moves value both ways inside one transaction the wallet signed.
     Instruction names only cover some venues, so the wallet's own balances
     before and after are checked too: something went out and something else
     came in. That catches pump.fun, PumpSwap and anything else without having
     to know each program. */
  const logs = tx.meta?.logMessages || [];
  const swapLog = logs.some((l) => /Instruction: (Swap|Route|SharedAccountsRoute|ExactOutRoute)/i.test(l));
  const balances = balanceMoves(tx, wallet, accountKeys);
  result.isSwap = walletSigns && (swapLog || (sawTokenIn && sawTokenOut) || (balances.gained && balances.lost));
  if (result.isSwap) {
    /* Swap legs are not deposits or withdrawals. Money sent in by another
       wallet that co-signed the transaction still is, so a top-up cannot be
       hidden inside a trade. Pools never sign, people do. */
    const otherSigners = new Set(
      (message.accountKeys || [])
        .filter((k) => typeof k === 'object' && k.signer && k.pubkey !== wallet)
        .map((k) => k.pubkey),
    );
    result.inbound = result.inbound.filter((m) => m.counterparty && otherSigners.has(m.counterparty));
    result.outbound = [];
  }

  return result;
}

/* Below this, a SOL change is rent for a token account, not a trade leg. */
const SOL_MOVE_THRESHOLD = 0.0025;

/** Did the wallet end the transaction with more of one thing and less of another? */
function balanceMoves(tx, wallet, accountKeys) {
  const meta = tx.meta;
  const change = new Map();
  if (!meta) return { gained: false, lost: false };

  const index = accountKeys.indexOf(wallet);
  if (index >= 0 && meta.preBalances && meta.postBalances) {
    let lamports = meta.postBalances[index] - meta.preBalances[index];
    if (index === 0) lamports += meta.fee ?? 0; // the network fee is not a trade leg
    change.set(SOL_MINT, lamports / 1e9);
  }

  /* Wrapped SOL shares SOL's mint, so it merges with native SOL here. */
  const add = (list, sign) => {
    for (const b of list || []) {
      if (b.owner !== wallet) continue;
      const amount = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
      change.set(b.mint, (change.get(b.mint) ?? 0) + sign * amount);
    }
  };
  add(meta.postTokenBalances, 1);
  add(meta.preTokenBalances, -1);

  let gained = false;
  let lost = false;
  for (const [mint, delta] of change) {
    const threshold = mint === SOL_MINT ? SOL_MOVE_THRESHOLD : 0;
    if (delta > threshold) gained = true;
    if (delta < -threshold) lost = true;
  }
  return { gained, lost };
}

function addFlag(entryId, kind, detail, signature) {
  run(
    `INSERT OR IGNORE INTO flags (entry_id, kind, detail, signature, ts) VALUES (?, ?, ?, ?, ?)`,
    entryId,
    kind,
    detail,
    signature ?? null,
    now(),
  );
}

/* ------------------------------------------------------------------ scoring */

/** Value everything the wallet holds, plus its cash-only subtotal. */
async function valueWallet(wallet) {
  const [sol, tokens, solPrice] = await Promise.all([getSolBalance(wallet), getTokenBalances(wallet), getSolPrice()]);

  const positions = [
    { mint: SOL_MINT, amount: sol, decimals: 9, raw: String(Math.round(sol * 1e9)) },
    ...tokens,
  ].filter((p) => p.amount > 0);

  const { totalUsd, positions: valued } = await valuePositions(positions);
  const cashUsd = valued.filter((p) => CASH_MINTS.has(p.mint)).reduce((sum, p) => sum + p.usd, 0);

  return { totalUsd, cashUsd, positions: valued, sol, solPrice };
}

/* ------------------------------------------------------------------- passes */

export async function indexEntry(entry, round) {
  const phase = phaseOf(round);
  const wallet = entry.comp_wallet;

  /* 1. New transactions, oldest first. */
  const signatures = (await getSignaturesSince(wallet, entry.last_signature, MAX_TX_PER_PASS)).reverse();

  /* Nothing new and priced recently? Stop here. That one signature check is
     the whole cost of a quiet minute, which is what makes minute-by-minute
     scoring affordable. Never skip the final pass, though: that is where only
     cash starts to count. */
  if (phase === 'trading' && !signatures.length && entry.indexed_at &&
      now() - entry.indexed_at < config.revalueIntervalSeconds) {
    return { entryId: entry.id, skipped: true, pnl: entry.pnl_usd, value: entry.value_usd, trades: entry.trades };
  }

  let deposits = entry.deposit_usd;
  let depositSol = entry.deposit_sol;
  let trades = entry.trades;
  let firstFunder = entry.first_funder;
  let firstDepositAt = entry.first_deposit_at;
  let newest = entry.last_signature;
  let dustOut = 0;

  const solPrice = await getSolPrice();

  for (const item of signatures) {
    const tx = await getParsedTransaction(item.signature);
    newest = item.signature;
    if (!tx || tx.meta?.err) continue;

    const moves = classifyTransaction(tx, wallet);
    const blockTime = moves.blockTime ?? item.blockTime ?? now();

    if (moves.isSwap) {
      trades += 1;
      continue;
    }

    for (const move of moves.inbound) {
      const mints = await getPrices([move.mint || SOL_MINT]);
      const usd = (mints.get(move.mint || SOL_MINT) ?? 0) * move.amount;

      const isFunding = move.mint === SOL_MINT || CASH_MINTS.has(move.mint);

      run(
        `INSERT OR IGNORE INTO transfers (entry_id, signature, direction, counterpny, mint, amount, usd, block_time)
         VALUES (?, ?, 'in', ?, ?, ?, ?, ?)`,
        entry.id,
        item.signature,
        move.counterparty ?? null,
        move.mint ?? null,
        move.amount,
        usd,
        blockTime,
      );

      if (!isFunding) continue; // unsolicited token airdrops are ignored
      if (usd < config.dustTransferUsd) continue; // rent top-ups and dust

      /* No deposit window: the first money in is the starting balance,
         whenever it arrives. Anything topped up afterwards is flagged for
         the end-of-round review rather than being scored as profit. */
      if (!firstFunder && !firstDepositAt) {
        deposits += usd;
        if (move.mint === SOL_MINT) depositSol += move.amount;
        firstFunder = move.counterparty ?? null;
        firstDepositAt = blockTime;
      } else if (firstDepositAt && blockTime - firstDepositAt <= config.depositGraceSeconds) {
        /* Funding sent in a few transactions back to back is one deposit. */
        deposits += usd;
        if (move.mint === SOL_MINT) depositSol += move.amount;
      } else {
        addFlag(entry.id, 'extra-deposit', `$${usd.toFixed(2)} was added after the opening deposit`, item.signature);
      }
    }

    for (const move of moves.outbound) {
      const mints = await getPrices([move.mint || SOL_MINT]);
      const usd = (mints.get(move.mint || SOL_MINT) ?? 0) * move.amount;
      run(
        `INSERT OR IGNORE INTO transfers (entry_id, signature, direction, counterpny, mint, amount, usd, block_time)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?)`,
        entry.id,
        item.signature,
        move.counterparty ?? null,
        move.mint ?? null,
        move.amount,
        usd,
        blockTime,
      );

      /* Priority fees, validator tips and rent leave the wallet constantly.
         Only a transfer big enough to be a real withdrawal is a rule break. */
      if (usd >= config.dustTransferUsd) {
        addFlag(entry.id, 'withdrawal', `$${usd.toFixed(2)} left the wallet`, item.signature);
      } else {
        dustOut += usd;
      }
    }
  }

  /* Lots of small outflows add up to a withdrawal drip. */
  if (dustOut > config.dustOutflowBudgetUsd) {
    addFlag(entry.id, 'dust-outflow', `$${dustOut.toFixed(2)} left the wallet in small transfers`, null);
  }

  if (deposits > config.depositCapUsd * 1.02) {
    addFlag(entry.id, 'over-cap', `opening deposit was $${deposits.toFixed(2)}, cap is $${config.depositCapUsd}`, null);
  }

  /* 2. Value the wallet. */
  const valuation = await valueWallet(wallet);
  const baseline = deposits > 0 ? deposits : entry.deposit_usd;
  const scoreValue = phase === 'review' || phase === 'settled' ? valuation.cashUsd : valuation.totalUsd;
  const pnl = baseline > 0 ? scoreValue - baseline : 0;
  const roi = baseline > 0 ? (pnl / baseline) * 100 : 0;

  run(
    `UPDATE entries SET
       deposit_usd = ?, deposit_sol = ?, first_funder = ?, first_deposit_at = ?,
       value_usd = ?, cash_usd = ?, pnl_usd = ?, roi_pct = ?, trades = ?,
       last_signature = ?, indexed_at = ?
     WHERE id = ?`,
    deposits,
    depositSol,
    firstFunder,
    firstDepositAt,
    valuation.totalUsd,
    valuation.cashUsd,
    pnl,
    roi,
    trades,
    newest,
    now(),
    entry.id,
  );

  run(`INSERT INTO valuations (entry_id, ts, value_usd, pnl_usd) VALUES (?, ?, ?, ?)`, entry.id, now(), valuation.totalUsd, pnl);

  return { entryId: entry.id, pnl, value: valuation.totalUsd, trades, solPrice };
}

/** One full pass over every active entry of a round. */
export async function indexRound(round) {
  const entries = queryAll(`SELECT * FROM entries WHERE round_id = ? AND status = 'active' ORDER BY id`, round.id);
  const results = [];
  for (const entry of entries) {
    try {
      results.push(await indexEntry(entry, round));
    } catch (err) {
      results.push({ entryId: entry.id, error: err.message });
    }
  }
  return results;
}

/* ---------------------------------------------------------------- finishing */

/** Freeze a finished round: rank the field and work out pot shares. */
export function finalizeRound(round) {
  const entries = queryAll(
    `SELECT * FROM entries WHERE round_id = ? AND status = 'active' ORDER BY pnl_usd DESC`,
    round.id,
  );

  entries.forEach((entry, index) => {
    run('UPDATE entries SET final_rank = ?, pot_share_pct = NULL WHERE id = ?', index + 1, entry.id);
  });

  const winners = entries.slice(0, 3).filter((e) => e.pnl_usd > 0);
  const total = winners.reduce((sum, e) => sum + e.pnl_usd, 0);
  for (const winner of winners) {
    const share = total > 0 ? (winner.pnl_usd / total) * 100 : 0;
    run('UPDATE entries SET pot_share_pct = ? WHERE id = ?', share, winner.id);
  }

  run(`UPDATE rounds SET status = 'review' WHERE id = ?`, round.id);
  return { ranked: entries.length, winners: winners.length, rolledOver: winners.length === 0 };
}

export { classifyTransaction };
