/* Ed25519 message-signature verification, using Node's own crypto.
   A wallet proves ownership by signing a message — no transaction, so the
   competition wallet stays at zero history. */

import crypto from 'node:crypto';
import { decodeBase58 } from './base58.js';

/* DER prefix for an Ed25519 SubjectPublicKeyInfo holding a raw 32 byte key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromAddress(address) {
  const raw = decodeBase58(address);
  if (raw.length !== 32) throw new Error('address is not a 32 byte key');
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * @param {string} address   base58 wallet address
 * @param {string} message   exact text that was signed
 * @param {string} signature base58 signature (what Phantom's signMessage returns)
 */
export function verifySignature(address, message, signature) {
  try {
    const key = publicKeyFromAddress(address);
    const sig = Buffer.from(decodeBase58(signature));
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** The exact text a wallet must sign to register. Keep in step with the frontend. */
export function registrationMessage({ role, roundNumber, wallet, nonce }) {
  return [
    'FirstTX registration',
    `Role: ${role}`,
    `Round: ${roundNumber}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    'Signing this proves you own the wallet. It is free and creates no transaction.',
  ].join('\n');
}
