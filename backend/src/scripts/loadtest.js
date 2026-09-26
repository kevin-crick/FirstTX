/* `node src/scripts/loadtest.js [wallets=150] [lateWallets=50] [minutes=50]`

   A full round on this computer, against live Solana and Jupiter, with
   brand-new wallets made on the spot and entered through the real sign-up
   endpoint. It starts its own server on a separate database (the real one is
   never touched), serves the site on http://localhost:5173 so the leaderboard
   can be watched, and writes a report to data/loadtest-<time>-report.md.

   The wallets are empty, so every score stays at $0. What this measures is
   whether the system keeps up: sign-ups, minute-by-minute scoring, the API
   under load, entries joining mid-round, the round ending by itself and the
   results being frozen. */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { encodeBase58 } from '../base58.js';
import { registrationMessage } from '../verify.js';

const WALLETS = Number(process.argv[2] || 150);
const LATE_WALLETS = Number(process.argv[3] || 50);
const MINUTES = Number(process.argv[4] || 50);
const LATE_AT_MINUTE = Math.min(10, Math.max(1, Math.floor(MINUTES / 3)));
const KEEP_UP_MINUTES = Number(process.env.LT_KEEP_UP_MINUTES ?? 180); // leave the site up afterwards so it can be browsed

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(here, '../..');
const SITE = path.resolve(BACKEND, '..');
/* Other ports let a second test run beside one that is still being browsed.
   The site's own pages only talk to 8787, so only the default is watchable. */
const API_PORT = Number(process.env.LT_API_PORT) || 8787;
const SITE_PORT = Number(process.env.LT_SITE_PORT) || 5173;
const API = `http://localhost:${API_PORT}`;
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const DATA = path.join(BACKEND, 'data');
fs.mkdirSync(DATA, { recursive: true });
const dbFile = path.join(DATA, `loadtest-${stamp}.db`);
const reportFile = path.join(DATA, `loadtest-${stamp}-report.md`);
const progressFile = path.join(DATA, `loadtest-${stamp}-progress.log`);
const token = crypto.randomBytes(24).toString('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const progress = (...args) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(progressFile, line + '\n');
};

/* ------------------------------------------------------------ the site */

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const site = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(SITE, p);
  if (!file.startsWith(SITE) || file.startsWith(BACKEND) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
site.listen(SITE_PORT);

/* ---------------------------------------------------------- the server */

const passes = [];
const serverProblems = [];
let finishedLine = null;
const serverLog = fs.createWriteStream(path.join(DATA, `loadtest-${stamp}-server.log`));
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: BACKEND,
  env: {
    ...process.env,
    DB_PATH: dbFile,
    ADMIN_TOKEN: token,
    COIN_MINT: '',
    FEE_WALLET: '',
    POT_PERCENT: '0',
    RATE_LIMIT_PER_MINUTE: '100000',
    /* Same timing as production (Railway uses the defaults), whatever the
       local .env says. */
    INDEX_INTERVAL_SECONDS: '60',
    REVALUE_INTERVAL_SECONDS: '300',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    PORT: String(API_PORT),
  },
});
server.stderr.on('data', (d) => serverLog.write(d));
server.stdout.on('data', (d) => {
  serverLog.write(d);
  for (const line of String(d).split(/\r?\n/)) {
    const pass = line.match(/^(\S+) round \d+: (\d+) wallets — (\d+) rescored, (\d+) unchanged(?:, (\d+) errors)?/);
    if (pass) passes.push({ at: Date.parse(pass[1]) / 1000, wallets: +pass[2], rescored: +pass[3], unchanged: +pass[4], errors: +(pass[5] || 0) });
    if (/tick failed|WARNING round|could not get a final/.test(line)) serverProblems.push(line);
    if (/finished:/.test(line)) finishedLine = line;
  }
});

async function call(method, p, body) {
  const started = Date.now();
  const res = await fetch(API + p, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, ms: Date.now() - started };
}

/* ------------------------------------------------------------ sign-ups */

function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { address: encodeBase58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), privateKey };
}
const sign = (key, message) => encodeBase58(crypto.sign(null, Buffer.from(message, 'utf8'), key));

const signups = [];
async function registerOne(roundNumber, signComp) {
  const holder = newWallet();
  const comp = newWallet();
  const nonce = (await call('GET', '/api/nonce')).body?.nonce;
  const payload = {
    nonce,
    holderWallet: holder.address,
    compWallet: comp.address,
    holderSignature: sign(holder.privateKey, registrationMessage({ role: 'holder', roundNumber, wallet: holder.address, nonce })),
  };
  if (signComp) {
    payload.compSignature = sign(comp.privateKey, registrationMessage({ role: 'competition', roundNumber, wallet: comp.address, nonce }));
  }
  const res = await call('POST', '/api/register', payload);
  signups.push({ ok: res.status === 201, status: res.status, error: res.body?.error, ms: res.ms });
  return res;
}

async function pool(count, width, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < count) {
        const i = next++;
        await fn(i).catch((err) => signups.push({ ok: false, status: 0, error: err.message, ms: 0 }));
      }
    }),
  );
}

/* ------------------------------------------------------------- run it */

const latency = [];
const samples = [];

try {
  for (let i = 0; i < 30; i++) {
    const ok = await fetch(API + '/api/health').then((r) => r.ok).catch(() => false);
    if (ok) break;
    await sleep(1000);
  }
  progress(`server up on its own database: ${path.basename(dbFile)}`);

  let round = (await call('GET', '/api/round')).body.registration;
  progress(`round ${round.number} open for entries — registering ${WALLETS} brand-new wallets`);

  const regStart = Date.now();
  await pool(WALLETS, 4, (i) => registerOne(round.number, i % 2 === 0));
  const early = signups.filter((s) => s.ok).length;
  progress(`registered ${early}/${WALLETS} in ${((Date.now() - regStart) / 1000).toFixed(0)}s`);
  const whyRefused = {};
  for (const s of signups.filter((x) => !x.ok)) whyRefused[s.error] = (whyRefused[s.error] || 0) + 1;
  if (Object.keys(whyRefused).length) progress(`refused: ${JSON.stringify(whyRefused)}`);

  /* A used mainnet wallet must still be refused under load. */
  {
    const holder = newWallet();
    const nonce = (await call('GET', '/api/nonce')).body?.nonce;
    const res = await call('POST', '/api/register', {
      nonce,
      holderWallet: holder.address,
      compWallet: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
      holderSignature: sign(holder.privateKey, registrationMessage({ role: 'holder', roundNumber: round.number, wallet: holder.address, nonce })),
    });
    progress(`used wallet refused: ${res.status === 400 ? 'yes' : 'NO'} (${res.body?.error})`);
    samples.push({ note: 'used wallet refused', ok: res.status === 400, detail: res.body?.error });
  }

  const start = await call('POST', '/api/admin/round/start', { hours: MINUTES / 60 });
  const pot = await call('POST', '/api/admin/pot', { round: round.number, potUsd: 1000 });
  round = start.body.round;
  progress(`round ${round.number} started for ${MINUTES} minutes (pot set: ${pot.status === 200 ? '$1,000' : 'FAILED'})`);

  const db = new DatabaseSync(dbFile);
  const t0 = nowS();
  let lateDone = false;
  let finalized = false;

  while (nowS() - t0 < (MINUTES + 20) * 60) {
    await sleep(60_000);
    const minute = Math.round((nowS() - t0) / 60);

    const r = await call('GET', '/api/round');
    const lb = await call('GET', '/api/leaderboard?limit=500');
    latency.push(r.ms, lb.ms);

    const s = db.prepare(
      `SELECT COUNT(*) AS n, SUM(indexed_at IS NULL) AS unscored, MIN(indexed_at) AS oldest
         FROM entries WHERE status = 'active'`,
    ).get();
    const oldestAge = s.oldest ? nowS() - s.oldest : null;
    const phase = r.body?.round?.phase;
    const lastPass = passes[passes.length - 1];
    progress(
      `min ${String(minute).padStart(2)} | ${phase} | ${s.n} wallets, ${s.unscored} not scored yet, ` +
        `oldest score ${oldestAge === null ? '—' : oldestAge + 's'} old | leaderboard ${lb.ms}ms, ${lb.body?.entries?.length} rows` +
        (lastPass ? ` | last pass ${lastPass.rescored} rescored, ${lastPass.errors} errors` : ''),
    );
    samples.push({ minute, phase, wallets: s.n, unscored: s.unscored, oldestAge, lbMs: lb.ms, rows: lb.body?.entries?.length });

    if (!lateDone && minute >= LATE_AT_MINUTE && phase === 'trading') {
      lateDone = true;
      const before = signups.filter((x) => x.ok).length;
      const t = Date.now();
      await pool(LATE_WALLETS, 4, (i) => registerOne(round.number, i % 2 === 0));
      progress(`mid-round: registered ${signups.filter((x) => x.ok).length - before}/${LATE_WALLETS} more in ${((Date.now() - t) / 1000).toFixed(0)}s`);
    }

    const frozen = db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE final_rank IS NOT NULL`).get().n;
    if (phase === 'review' && frozen > 0) {
      finalized = true;
      break;
    }
  }

  /* ------------------------------------------------------------ results */

  const review = await call('GET', '/api/admin/review');
  const history = await call('GET', '/api/history');
  const wallet = review.body?.entries?.[0]
    ? await call('GET', `/api/wallet/${review.body.entries[0].address}`)
    : null;
  const regs = signups.filter((s) => s.ok);
  const refused = signups.filter((s) => !s.ok);
  const regMs = regs.map((s) => s.ms).sort((a, b) => a - b);
  const gaps = passes.slice(1).map((p, i) => p.at - passes[i].at);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const passErrors = passes.reduce((a, p) => a + p.errors, 0);
  const maxAge = Math.max(0, ...samples.filter((x) => x.oldestAge !== undefined && x.phase === 'trading').map((x) => x.oldestAge || 0));
  const lat = latency.sort((a, b) => a - b);
  const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);
  const reasons = {};
  for (const r of refused) reasons[r.error || `http ${r.status}`] = (reasons[r.error || `http ${r.status}`] || 0) + 1;

  const verdict = [];
  verdict.push(regs.length === WALLETS + LATE_WALLETS ? 'PASS  every sign-up went through' : `FAIL  ${refused.length} sign-ups were refused`);
  verdict.push(samples.some((x) => x.note === 'used wallet refused' && x.ok) ? 'PASS  a used wallet is still refused under load' : 'FAIL  a used wallet got through');
  verdict.push(maxAge <= 420 ? `PASS  every score stayed fresh (oldest ${maxAge}s, limit 420s)` : `FAIL  scores fell behind (oldest ${maxAge}s)`);
  verdict.push(passErrors === 0 ? 'PASS  no wallet errors while scoring' : `WARN  ${passErrors} wallet errors while scoring (retried next pass)`);
  verdict.push(pct(lat, 0.95) < 1000 ? `PASS  site stayed fast (95% of requests under ${pct(lat, 0.95)}ms)` : `FAIL  site was slow (95th percentile ${pct(lat, 0.95)}ms)`);
  verdict.push(finalized ? 'PASS  round ended by itself and results were frozen' : 'FAIL  round did not finish and freeze in time');
  verdict.push(serverProblems.length === 0 ? 'PASS  no server failures logged' : `FAIL  ${serverProblems.length} server problems logged`);

  const md = [
    `# FirstTX load test — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `${WALLETS} brand-new wallets entered before the start, ${LATE_WALLETS} more at minute ${LATE_AT_MINUTE}, one ${MINUTES}-minute round, live Solana (Helius) and Jupiter data, separate test database. Wallets are empty, so scores stay at $0 — this measures whether the system keeps up.`,
    '',
    '## Verdict',
    '',
    ...verdict.map((v) => `- ${v}`),
    '',
    '## Numbers',
    '',
    `| | |`,
    `|---|---|`,
    `| Sign-ups accepted | ${regs.length} of ${WALLETS + LATE_WALLETS} |`,
    `| Sign-up time (typical / slowest) | ${pct(regMs, 0.5)}ms / ${regMs[regMs.length - 1] ?? 0}ms |`,
    `| Refused, by reason | ${Object.entries(reasons).map(([k, v]) => `${v}× ${k}`).join('; ') || 'none'} |`,
    `| Scoring passes | ${passes.length} |`,
    `| Time between passes (average / longest) | ${avgGap.toFixed(0)}s / ${maxGap}s (target 60s) |`,
    `| Oldest score during the round | ${maxAge}s (a quiet wallet is re-priced every 300s) |`,
    `| Wallet errors while scoring | ${passErrors} |`,
    `| API response (typical / 95% / slowest) | ${pct(lat, 0.5)}ms / ${pct(lat, 0.95)}ms / ${lat[lat.length - 1] ?? 0}ms |`,
    `| Round result | ${finishedLine ? finishedLine.replace(/^\S+ /, '') : 'not finished'} |`,
    `| Past rounds page | ${history.body?.rounds?.length ?? 0} round(s) listed |`,
    `| Wallet page history points (top wallet) | ${wallet?.body?.history?.length ?? '—'} |`,
    '',
    serverProblems.length ? '## Server problems\n\n```\n' + serverProblems.slice(0, 30).join('\n') + '\n```\n' : '',
    '## Minute by minute',
    '',
    '| Minute | Phase | Wallets | Not yet scored | Oldest score | Leaderboard response |',
    '|---|---|---|---|---|---|',
    ...samples.filter((x) => x.minute !== undefined).map((x) => `| ${x.minute} | ${x.phase} | ${x.wallets} | ${x.unscored} | ${x.oldestAge ?? '—'}s | ${x.lbMs}ms |`),
    '',
  ].join('\n');
  fs.writeFileSync(reportFile, md);
  progress(`REPORT WRITTEN: ${reportFile}`);
  for (const v of verdict) progress(v);
} catch (err) {
  progress(`LOAD TEST CRASHED: ${err.stack || err.message}`);
}

const until = new Date(Date.now() + KEEP_UP_MINUTES * 60_000);
progress(`site stays up at http://localhost:${SITE_PORT}/leaderboard.html until ${until.toTimeString().slice(0, 5)}`);
await sleep(KEEP_UP_MINUTES * 60_000);
server.kill();
site.close();
process.exit(0);
