/* `node src/scripts/selftest.js` — checks the rules the backend must enforce,
   against a running server and live mainnet data.

   Every wallet used here is a freshly generated keypair, so the freshness
   checks are real, not mocked. */

import crypto from 'node:crypto';
import { encodeBase58 } from '../base58.js';
import { registrationMessage, verifySignature } from '../verify.js';
import { classifyTransaction } from '../indexer.js';
import { inspectFreshness } from '../solana.js';

const API = process.argv[2] || 'http://localhost:8787';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? passed++ : failed++;
};

/* A refusal only counts when the server gave the reason we expected.
   Otherwise a rate-limit reply would make every rejection test "pass". */
const refusedBecause = (res, fragment) =>
  res.status >= 400 && res.status !== 429 && String(res.body?.error || '').toLowerCase().includes(fragment);

function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { address: encodeBase58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), privateKey };
}
const sign = (key, message) => encodeBase58(crypto.sign(null, Buffer.from(message, 'utf8'), key));
const getJson = async (path) => (await fetch(API + path)).json();

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function buildRegistration({ holder = newWallet(), comp = newWallet(), nonce, round }) {
  nonce = nonce || (await getJson('/api/nonce')).nonce;
  return {
    nonce,
    holderWallet: holder.address,
    compWallet: comp.address,
    holderSignature: sign(holder.privateKey, registrationMessage({ role: 'holder', roundNumber: round.number, wallet: holder.address, nonce })),
    compSignature: sign(comp.privateKey, registrationMessage({ role: 'competition', roundNumber: round.number, wallet: comp.address, nonce })),
    _holder: holder,
    _comp: comp,
  };
}

/* ---------------------------------------------------------- offline units */

{
  const wallet = newWallet();
  const message = 'FirstTX test message';
  check('signature verifies', verifySignature(wallet.address, message, sign(wallet.privateKey, message)));
  check('tampered message fails', !verifySignature(wallet.address, message + '!', sign(wallet.privateKey, message)));
  const other = newWallet();
  check('other wallet cannot sign for you', !verifySignature(wallet.address, message, sign(other.privateKey, message)));
}

{
  /* A plain SOL transfer into the wallet is a deposit, not a trade. */
  const wallet = 'Dep11111111111111111111111111111111111111111';
  const tx = {
    blockTime: 1,
    meta: { logMessages: [] },
    transaction: {
      message: {
        accountKeys: [{ pubkey: 'Sender1111111111111111111111111111111111111', signer: true }, { pubkey: wallet, signer: false }],
        instructions: [
          { program: 'system', parsed: { type: 'transfer', info: { source: 'Sender1111111111111111111111111111111111111', destination: wallet, lamports: 2_000_000_000 } } },
        ],
      },
    },
  };
  const moves = classifyTransaction(tx, wallet);
  check('inbound SOL is seen as a deposit', moves.inbound.length === 1 && moves.inbound[0].amount === 2 && !moves.isSwap);

  /* The same transfer, the other way round, is a withdrawal. */
  const out = classifyTransaction(
    {
      blockTime: 2,
      meta: { logMessages: [] },
      transaction: {
        message: {
          accountKeys: [{ pubkey: wallet, signer: true }, { pubkey: 'Other111111111111111111111111111111111111111', signer: false }],
          instructions: [
            { program: 'system', parsed: { type: 'transfer', info: { source: wallet, destination: 'Other111111111111111111111111111111111111111', lamports: 500_000_000 } } },
          ],
        },
      },
    },
    wallet,
  );
  check('outbound SOL is seen as a withdrawal', out.outbound.length === 1 && out.outbound[0].amount === 0.5);

  /* A swap is a trade, and must not count as a deposit or a withdrawal. */
  const swap = classifyTransaction(
    {
      blockTime: 3,
      meta: { logMessages: ['Program log: Instruction: SharedAccountsRoute'] },
      transaction: {
        message: {
          accountKeys: [{ pubkey: wallet, signer: true }],
          instructions: [
            { program: 'spl-token', parsed: { type: 'transferChecked', info: { authority: wallet, mint: 'Mint1', tokenAmount: { uiAmount: 10 } } } },
          ],
        },
      },
    },
    wallet,
  );
  check('swap counts as a trade only', swap.isSwap && swap.inbound.length === 0 && swap.outbound.length === 0);
}

/* ------------------------------------------------------------- live server */

const health = await getJson('/api/health').catch(() => null);
if (!health?.ok) {
  console.log('\nServer is not running — start it with `npm start` to run the API tests.');
  process.exit(failed ? 1 : 0);
}

const info = await getJson('/api/round');
const round = info.registration || info.round;
check('a round is open for registration', Boolean(round), round ? `round ${round.number} (${round.phase})` : 'none');

{
  const payload = await buildRegistration({ round });
  const res = await post('/api/register', payload);
  check('clean wallet pair registers', res.status === 201, JSON.stringify(res.body).slice(0, 120));

  /* Same nonce twice must fail. */
  const replay = await post('/api/register', { ...payload, compWallet: payload.compWallet });
  check('nonce cannot be replayed', refusedBecause(replay, 'nonce'), replay.body.error);

  /* Same competition wallet again, with a fresh nonce. */
  const again = await buildRegistration({ comp: payload._comp, round });
  const dup = await post('/api/register', again);
  check('wallet cannot enter twice', refusedBecause(dup, 'already entered'), dup.body.error);

  /* Same holder wallet, different competition wallet. */
  const sameHolder = await buildRegistration({ holder: payload._holder, round });
  const dupHolder = await post('/api/register', sameHolder);
  check('one entry per holder wallet', refusedBecause(dupHolder, 'one entry per holder'), dupHolder.body.error);
}

{
  /* Freshness, against live mainnet. We cannot sign for someone else's wallet,
     so this checks the rule itself rather than going through the API: a real
     used mainnet account must fail, a brand-new keypair must pass. */
  const used = await inspectFreshness('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
  check('used mainnet wallet fails the freshness check', used.fresh === false, used.reasons.join('; '));

  const unused = await inspectFreshness(newWallet().address);
  check('brand-new wallet passes the freshness check', unused.fresh === true);
}

{
  const bad = await buildRegistration({ round });
  bad.holderSignature = sign(newWallet().privateKey, 'unrelated message'); // not the holder's
  const res = await post('/api/register', bad);
  check('bad holder signature is refused', refusedBecause(res, 'signature'), res.body.error);
}

{
  /* The competition wallet is pasted in, so no signature is required. */
  const payload = await buildRegistration({ round });
  delete payload.compSignature;
  const res = await post('/api/register', payload);
  check('pasted competition wallet is accepted without signing', res.status === 201, res.body.error || 'entry created');
  check('entry records that it was not signed', res.body?.compSigned === false, 'compSigned=' + res.body?.compSigned);
}

{
  const payload = await buildRegistration({ round });
  payload.compWallet = 'not-a-real-address';
  const res = await post('/api/register', payload);
  check('a junk address is refused', refusedBecause(res, 'valid solana address'), res.body.error);
}

{
  const same = newWallet();
  const nonce = (await getJson('/api/nonce')).nonce;
  const res = await post('/api/register', {
    nonce,
    holderWallet: same.address,
    compWallet: same.address,
    holderSignature: sign(same.privateKey, registrationMessage({ role: 'holder', roundNumber: round.number, wallet: same.address, nonce })),
    compSignature: sign(same.privateKey, registrationMessage({ role: 'competition', roundNumber: round.number, wallet: same.address, nonce })),
  });
  check('holder and competition wallet must differ', refusedBecause(res, 'must be different'), res.body.error);
}

{
  /* Joining a round that is already running must work, with the latecomer
     getting their own deposit window. */
  const info = await getJson('/api/round');
  if (info.round && info.round.phase === 'trading') {
    const late = await buildRegistration({ round: info.round });
    const res = await post('/api/register', late);
    check('can enter a round already in progress', res.status === 201, res.body.error || 'entry created');
    check('no funding deadline is imposed', res.body?.depositDeadline === 0, 'depositDeadline=' + res.body?.depositDeadline);
  } else {
    console.log('SKIP  mid-round entry — no round is running');
  }
}

{
  const board = await getJson('/api/leaderboard');
  check('leaderboard responds', Array.isArray(board.entries), `${board.entries?.length ?? 0} entries`);
  const admin = await fetch(API + '/api/admin/review');
  check('admin endpoint needs a token', admin.status === 401);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
