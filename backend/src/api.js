/* HTTP API. Plain node:http — no framework. */

import { config } from './config.js';
import { queryAll, queryOne, run, now } from './db.js';
import { currentRound, registrationRound, phaseOf, ensureRounds, takeSnapshot } from './rounds.js';
import { issueNonce, register, RegistrationError } from './registration.js';
import { finalizeRound } from './indexer.js';

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

function cors(req, res) {
  const origin = req.headers.origin;
  /* No Origin header means a non-browser caller (curl, a script, a health
     check). The browser-origin allowlist only applies to browsers. */
  const normalized = origin ? origin.replace(/\/+$/, '') : '';
  const allowed = !origin || config.allowedOrigins.includes('*') || config.allowedOrigins.includes(normalized);
  if (allowed && origin) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  return allowed;
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

/* Simple per-IP rate limit for the write endpoints. */
const hits = new Map();
function rateLimited(req, max = config.rateLimitPerMinute, windowMs = 60_000) {
  const ip = req.socket.remoteAddress || 'unknown';
  const nowMs = Date.now();
  const list = (hits.get(ip) || []).filter((t) => nowMs - t < windowMs);
  list.push(nowMs);
  hits.set(ip, list);
  return list.length > max;
}

const isAdmin = (req) =>
  Boolean(config.adminToken) && req.headers.authorization === `Bearer ${config.adminToken}`;

function roundPayload(round) {
  if (!round) return null;
  const entered = queryOne(`SELECT COUNT(*) AS n FROM entries WHERE round_id = ? AND status = 'active'`, round.id);
  return {
    number: round.number,
    phase: phaseOf(round),
    status: round.status,
    snapshotAt: round.snapshot_at,
    opensAt: round.opens_at,
    depositClosesAt: round.deposit_closes_at,
    endsAt: round.ends_at,
    potUsd: round.pot_usd,
    walletsEntered: entered?.n ?? 0,
    depositCapUsd: config.depositCapUsd,
    minHoldUsd: config.minHoldUsd,
    coinMint: round.coin_mint || null,
    serverTime: now(),
  };
}

function leaderboardPayload(round, { limit = 500, sort = 'pnl' } = {}) {
  if (!round) return { round: null, entries: [] };
  const column = sort === 'roi' ? 'roi_pct' : sort === 'trades' ? 'trades' : 'pnl_usd';
  const rows = queryAll(
    `SELECT comp_wallet, deposit_usd, pnl_usd, roi_pct, trades, value_usd, cash_usd, indexed_at, final_rank, pot_share_pct
       FROM entries
      WHERE round_id = ? AND status = 'active'
      ORDER BY ${column} DESC, id ASC
      LIMIT ?`,
    round.id,
    Math.min(Number(limit) || 500, 1000),
  );
  return {
    round: roundPayload(round),
    entries: rows.map((row, index) => ({
      rank: index + 1,
      address: row.comp_wallet,
      deposit: row.deposit_usd,
      pnl: row.pnl_usd,
      roi: row.roi_pct,
      trades: row.trades,
      value: row.value_usd,
      cash: row.cash_usd,
      potShare: row.pot_share_pct,
      updatedAt: row.indexed_at,
    })),
  };
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (!allowed && req.method !== 'GET') {
    return json(res, 403, { error: 'origin not allowed' });
  }

  try {
    /* ---------------------------------------------------------- public */
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, time: now(), coinMint: config.coinMint || null });
    }

    if (req.method === 'GET' && path === '/api/round') {
      return json(res, 200, { round: roundPayload(currentRound()), registration: roundPayload(registrationRound()) });
    }

    if (req.method === 'GET' && path === '/api/leaderboard') {
      const round = url.searchParams.get('round')
        ? queryOne('SELECT * FROM rounds WHERE number = ?', Number(url.searchParams.get('round')))
        : currentRound();
      return json(res, 200, leaderboardPayload(round, {
        limit: url.searchParams.get('limit'),
        sort: url.searchParams.get('sort'),
      }));
    }

    if (req.method === 'GET' && path.startsWith('/api/wallet/')) {
      const address = decodeURIComponent(path.slice('/api/wallet/'.length));
      const entry = queryOne(
        `SELECT e.*, r.number AS round_number, r.ends_at, r.opens_at
           FROM entries e JOIN rounds r ON r.id = e.round_id
          WHERE e.comp_wallet = ? ORDER BY e.id DESC LIMIT 1`,
        address,
      );
      if (!entry) return json(res, 404, { error: 'wallet is not entered in any round' });
      const history = queryAll(
        'SELECT ts, value_usd AS value, pnl_usd AS pnl FROM valuations WHERE entry_id = ? ORDER BY ts ASC LIMIT 600',
        entry.id,
      );
      return json(res, 200, {
        address: entry.comp_wallet,
        round: entry.round_number,
        status: entry.status,
        deposit: entry.deposit_usd,
        pnl: entry.pnl_usd,
        roi: entry.roi_pct,
        trades: entry.trades,
        value: entry.value_usd,
        cash: entry.cash_usd,
        rank: entry.final_rank,
        potShare: entry.pot_share_pct,
        updatedAt: entry.indexed_at,
        solscan: `https://solscan.io/account/${entry.comp_wallet}`,
        history,
      });
    }

    if (req.method === 'GET' && path === '/api/nonce') {
      if (rateLimited(req, config.rateLimitPerMinute * 3)) return json(res, 429, { error: 'slow down' });
      return json(res, 200, { nonce: issueNonce(), expiresInSeconds: 600 });
    }

    if (req.method === 'POST' && path === '/api/register') {
      if (rateLimited(req)) return json(res, 429, { error: 'slow down' });
      const body = await readJsonBody(req);
      try {
        const result = await register(body);
        return json(res, 201, { ok: true, ...result });
      } catch (err) {
        if (err instanceof RegistrationError) return json(res, err.status, { error: err.message });
        throw err;
      }
    }

    /* ----------------------------------------------------------- admin */
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'admin token required' });

      if (req.method === 'GET' && path === '/api/admin/review') {
        const round = url.searchParams.get('round')
          ? queryOne('SELECT * FROM rounds WHERE number = ?', Number(url.searchParams.get('round')))
          : currentRound();
        if (!round) return json(res, 404, { error: 'round not found' });

        const top = queryAll(
          `SELECT * FROM entries WHERE round_id = ? AND status = 'active' ORDER BY pnl_usd DESC LIMIT 10`,
          round.id,
        );
        return json(res, 200, {
          round: roundPayload(round),
          entries: top.map((entry) => ({
            id: entry.id,
            address: entry.comp_wallet,
            holderWallet: entry.holder_wallet,
            holdVerified: Boolean(entry.hold_verified),
            holdUsd: entry.hold_usd,
            deposit: entry.deposit_usd,
            firstFunder: entry.first_funder,
            pnl: entry.pnl_usd,
            roi: entry.roi_pct,
            trades: entry.trades,
            potShare: entry.pot_share_pct,
            solscan: `https://solscan.io/account/${entry.comp_wallet}`,
            flags: queryAll('SELECT kind, detail, signature, ts FROM flags WHERE entry_id = ?', entry.id),
            transfers: queryAll(
              `SELECT direction, counterpny AS counterparty, mint, amount, usd, block_time AS blockTime, signature
                 FROM transfers WHERE entry_id = ? ORDER BY block_time ASC LIMIT 50`,
              entry.id,
            ),
          })),
          sharedFunders: queryAll(
            `SELECT first_funder AS funder, COUNT(*) AS entries
               FROM entries WHERE round_id = ? AND first_funder IS NOT NULL
               GROUP BY first_funder HAVING COUNT(*) > 1`,
            round.id,
          ),
        });
      }

      if (req.method === 'POST' && path === '/api/admin/disqualify') {
        const body = await readJsonBody(req);
        const entry = queryOne('SELECT * FROM entries WHERE id = ?', Number(body.entryId));
        if (!entry) return json(res, 404, { error: 'entry not found' });
        run(`UPDATE entries SET status = 'disqualified', dq_reason = ? WHERE id = ?`, String(body.reason || 'rule break'), entry.id);
        const round = queryOne('SELECT * FROM rounds WHERE id = ?', entry.round_id);
        finalizeRound(round);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/admin/pot') {
        const body = await readJsonBody(req);
        const round = queryOne('SELECT * FROM rounds WHERE number = ?', Number(body.round));
        if (!round) return json(res, 404, { error: 'round not found' });
        run('UPDATE rounds SET pot_usd = ? WHERE id = ?', Number(body.potUsd) || 0, round.id);
        return json(res, 200, { ok: true, potUsd: Number(body.potUsd) || 0 });
      }

      if (req.method === 'POST' && path === '/api/admin/finalize') {
        const body = await readJsonBody(req);
        const round = body.round
          ? queryOne('SELECT * FROM rounds WHERE number = ?', Number(body.round))
          : currentRound();
        if (!round) return json(res, 404, { error: 'round not found' });
        return json(res, 200, { ok: true, ...finalizeRound(round) });
      }

      if (req.method === 'POST' && path === '/api/admin/payout') {
        const body = await readJsonBody(req);
        const entry = queryOne('SELECT * FROM entries WHERE id = ?', Number(body.entryId));
        if (!entry) return json(res, 404, { error: 'entry not found' });
        run(
          `INSERT INTO payouts (round_id, entry_id, rank, share_pct, amount_usd, signature, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          entry.round_id,
          entry.id,
          Number(body.rank) || entry.final_rank || 0,
          Number(body.sharePct) || entry.pot_share_pct || 0,
          Number(body.amountUsd) || null,
          String(body.signature || ''),
          now(),
        );
        run(`UPDATE rounds SET status = 'settled' WHERE id = ?`, entry.round_id);
        return json(res, 201, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/admin/snapshot') {
        const body = await readJsonBody(req);
        const round = body.round
          ? queryOne('SELECT * FROM rounds WHERE number = ?', Number(body.round))
          : registrationRound() || currentRound();
        if (!round) return json(res, 404, { error: 'round not found' });
        const result = await takeSnapshot(round.id);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && path === '/api/admin/rounds') {
        ensureRounds();
        return json(res, 200, { ok: true, rounds: queryAll('SELECT number, status, opens_at, ends_at FROM rounds ORDER BY number DESC LIMIT 5') });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}
