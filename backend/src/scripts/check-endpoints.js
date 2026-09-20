/* `npm run check` — confirms the outside world is reachable and the
   competition rules can actually be enforced with the current settings. */

import { config, SOL_MINT } from '../config.js';
import { rpc, getMintHolders, getMintHoldersViaDas, inspectFreshness } from '../solana.js';
import { getPrices, getSellQuoteUsd } from '../prices.js';

const line = (label, ok, detail = '') => console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);

/* Never print the key: this output gets pasted into chats and screenshots. */
const safeRpc = config.rpcUrl.replace(/(api-key=)[^&]+/i, '$1••••••••');
console.log(`RPC: ${safeRpc}`);
console.log(`Coin mint: ${config.coinMint || '(not set)'}\n`);

try {
  const version = await rpc('getVersion');
  line('Solana RPC', true, `node version ${version['solana-core']}`);
} catch (err) {
  line('Solana RPC', false, err.message);
}

try {
  const prices = await getPrices([SOL_MINT]);
  line('Jupiter price API', true, `SOL $${(prices.get(SOL_MINT) ?? 0).toFixed(2)}`);
} catch (err) {
  line('Jupiter price API', false, err.message);
}

try {
  const usd = await getSellQuoteUsd(SOL_MINT, '1000000000');
  line('Jupiter quote API', usd !== null, usd !== null ? `selling 1 SOL returns $${usd.toFixed(2)}` : 'no route');
} catch (err) {
  line('Jupiter quote API', false, err.message);
}

try {
  const check = await inspectFreshness('11111111111111111111111111111111');
  line('Freshness check', true, check.fresh ? 'clean wallet' : check.reasons.join('; '));
} catch (err) {
  line('Freshness check', false, err.message);
}

const isHelius = /helius/i.test(config.rpcUrl);

if (config.coinMint) {
  try {
    const holders = isHelius ? await getMintHoldersViaDas(config.coinMint) : await getMintHolders(config.coinMint);
    line(`Holder snapshot (${isHelius ? 'Helius getTokenAccounts' : 'getProgramAccounts'})`, true, `${holders.size} holders`);
  } catch (err) {
    line('Holder snapshot', false, err.message);
  }
} else {
  /* No coin yet: prove the snapshot call itself works, using a known mint. */
  try {
    const probe = await rpc(
      isHelius ? 'getTokenAccounts' : 'getTokenSupply',
      isHelius ? { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', limit: 3 } : ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    );
    const works = isHelius ? Array.isArray(probe?.token_accounts) : Boolean(probe?.value);
    line('Holder snapshot method', works, works ? 'ready — set COIN_MINT when the coin launches' : 'unexpected response');
  } catch (err) {
    line('Holder snapshot method', false, err.message);
  }
}
