/* Development helper: registers a throwaway pair of wallets against a running
   server, exactly the way the website does it. Generated keys are real
   Solana keypairs that have never touched the chain, so the freshness check
   is a genuine pass, not a mock.

   Usage: node src/scripts/dev-register.js [apiBase] */

import crypto from 'node:crypto';
import { encodeBase58 } from '../base58.js';
import { registrationMessage } from '../verify.js';

const API = process.argv[2] || 'http://localhost:8787';

function newWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: encodeBase58(raw), privateKey };
}

const sign = (privateKey, message) =>
  encodeBase58(crypto.sign(null, Buffer.from(message, 'utf8'), privateKey));

const roundInfo = await (await fetch(`${API}/api/round`)).json();
const round = roundInfo.registration || roundInfo.round;
if (!round) throw new Error('no round is open for registration');

const { nonce } = await (await fetch(`${API}/api/nonce`)).json();

const holder = newWallet();
const comp = newWallet();

const body = {
  nonce,
  holderWallet: holder.address,
  compWallet: comp.address,
  holderSignature: sign(
    holder.privateKey,
    registrationMessage({ role: 'holder', roundNumber: round.number, wallet: holder.address, nonce }),
  ),
  compSignature: sign(
    comp.privateKey,
    registrationMessage({ role: 'competition', roundNumber: round.number, wallet: comp.address, nonce }),
  ),
};

const res = await fetch(`${API}/api/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

console.log(res.status, await res.json());
console.log('competition wallet:', comp.address);
