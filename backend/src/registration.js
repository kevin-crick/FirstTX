/* Registration: two wallets, two signatures, three checks. */

import crypto from 'node:crypto';
import { config } from './config.js';
import { queryOne, run, now } from './db.js';
import { isValidAddress } from './base58.js';
import { verifySignature, registrationMessage } from './verify.js';
import { inspectFreshness, getMintBalance } from './solana.js';
import { getPrices } from './prices.js';
import { registrationRound, phaseOf, holderSnapshotEntry } from './rounds.js';

const NONCE_TTL_SECONDS = 600;

export function issueNonce() {
  const nonce = crypto.randomBytes(16).toString('hex');
  run('INSERT INTO nonces (nonce, created_at) VALUES (?, ?)', nonce, now());
  return nonce;
}

function consumeNonce(nonce) {
  const row = queryOne('SELECT * FROM nonces WHERE nonce = ?', nonce);
  if (!row) return { ok: false, reason: 'unknown nonce — start again' };
  if (row.used_at) return { ok: false, reason: 'that nonce was already used' };
  if (now() - row.created_at > NONCE_TTL_SECONDS) return { ok: false, reason: 'the nonce expired — start again' };
  run('UPDATE nonces SET used_at = ? WHERE nonce = ?', now(), nonce);
  return { ok: true };
}

class RegistrationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{holderWallet,holderSignature,compWallet,compSignature,nonce}} input
 */
export async function register(input) {
  const holderWallet = String(input.holderWallet || '').trim();
  const compWallet = String(input.compWallet || '').trim();
  const nonce = String(input.nonce || '').trim();

  if (!isValidAddress(holderWallet)) throw new RegistrationError('holder wallet is not a valid Solana address');
  if (!isValidAddress(compWallet)) throw new RegistrationError('competition wallet is not a valid Solana address');
  if (holderWallet === compWallet) {
    throw new RegistrationError('the two wallets must be different: your competition wallet has to be empty');
  }

  const round = registrationRound();
  if (!round) throw new RegistrationError('registration is closed right now', 409);
  const phase = phaseOf(round);
  if (phase === 'review' || phase === 'settled' || phase === 'none') {
    throw new RegistrationError('that round has finished', 409);
  }

  const nonceCheck = consumeNonce(nonce);
  if (!nonceCheck.ok) throw new RegistrationError(nonceCheck.reason);

  /* 1. Both signatures. */
  const holderMessage = registrationMessage({ role: 'holder', roundNumber: round.number, wallet: holderWallet, nonce });
  const compMessage = registrationMessage({ role: 'competition', roundNumber: round.number, wallet: compWallet, nonce });
  if (!verifySignature(holderWallet, holderMessage, String(input.holderSignature || ''))) {
    throw new RegistrationError('holder wallet signature did not verify');
  }
  /* The competition wallet may simply be pasted in. A signature is accepted
     when the wallet is connected, and recorded, but it is not required: the
     wallet must be empty anyway, and the top three are reviewed by hand. */
  let compSigned = 0;
  if (input.compSignature) {
    if (!verifySignature(compWallet, compMessage, String(input.compSignature))) {
      throw new RegistrationError('competition wallet signature did not verify');
    }
    compSigned = 1;
  }

  /* 2. Not already entered. */
  if (queryOne('SELECT id FROM entries WHERE round_id = ? AND comp_wallet = ?', round.id, compWallet)) {
    throw new RegistrationError('that competition wallet is already entered in this round', 409);
  }
  if (queryOne('SELECT id FROM entries WHERE round_id = ? AND holder_wallet = ?', round.id, holderWallet)) {
    throw new RegistrationError('that holder wallet already has an entry in this round — one entry per holder wallet', 409);
  }

  /* 3. The competition wallet is clean. */
  const freshness = await inspectFreshness(compWallet);
  if (!freshness.fresh) {
    throw new RegistrationError(`competition wallet is not clean: ${freshness.reasons.join('; ')}`);
  }

  /* 4. The holder wallet held at least the minimum at the snapshot. */
  const hold = await checkHolding(round, holderWallet);
  if (!hold.ok) throw new RegistrationError(hold.reason);

  /* Entering mid-round is allowed, and there is no funding deadline: fund the
     wallet whenever you like. The first money in becomes the starting balance. */
  const depositDeadline = 0;

  run(
    `INSERT INTO entries (round_id, comp_wallet, holder_wallet, registered_at, status, hold_verified, hold_usd, comp_signed, deposit_deadline)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    round.id,
    compWallet,
    holderWallet,
    now(),
    hold.verified ? 1 : 0,
    hold.usd,
    compSigned,
    depositDeadline,
  );

  const entry = queryOne('SELECT * FROM entries WHERE round_id = ? AND comp_wallet = ?', round.id, compWallet);
  return {
    entryId: entry.id,
    round: { number: round.number, opensAt: round.opens_at, depositClosesAt: round.deposit_closes_at, endsAt: round.ends_at },
    holdVerified: Boolean(hold.verified),
    compSigned: Boolean(compSigned),
    holdUsd: hold.usd,
    depositDeadline: 0,
    depositCapUsd: config.depositCapUsd,
  };
}

/**
 * Preferred path: the wallet is in the round's holder snapshot.
 * Fallback (snapshot unavailable, e.g. public RPC): check the live balance and
 * mark the entry unverified so it shows up in the manual review.
 */
async function checkHolding(round, holderWallet) {
  if (!config.coinMint) {
    return { ok: true, verified: false, usd: 0, note: 'COIN_MINT not set — holding requirement skipped' };
  }

  const snapshot = holderSnapshotEntry(round.id, holderWallet);
  if (snapshot) return { ok: true, verified: true, usd: snapshot.usd_value };

  if (round.snapshot_status === 'done') {
    return {
      ok: false,
      reason: `that wallet did not hold $${config.minHoldUsd} of the coin when registration opened. Buy before the next snapshot to join the next round.`,
    };
  }

  /* Snapshot missing: fall back to a live balance check. */
  const [amount, prices] = await Promise.all([getMintBalance(holderWallet, config.coinMint), getPrices([config.coinMint])]);
  const usd = amount * (prices.get(config.coinMint) ?? 0);
  if (usd < config.minHoldUsd) {
    return { ok: false, reason: `holder wallet holds $${usd.toFixed(2)} of the coin, and $${config.minHoldUsd} is the minimum` };
  }
  return { ok: true, verified: false, usd };
}

export { RegistrationError };
