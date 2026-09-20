/* Thin JSON-RPC client for Solana plus the queries the competition needs. */

import { config, SOL_MINT } from './config.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

let requestId = 0;

export async function rpc(method, params = [], { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`rpc http ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
    }
  }
  throw lastError;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getSolBalance(address) {
  const result = await rpc('getBalance', [address, { commitment: 'confirmed' }]);
  return (result?.value ?? 0) / 1e9;
}

/** All SPL token balances for an owner, both token programs. */
export async function getTokenBalances(owner) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    let result;
    try {
      result = await rpc('getTokenAccountsByOwner', [
        owner,
        { programId },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
    } catch {
      continue;
    }
    for (const account of result?.value ?? []) {
      const info = account.account?.data?.parsed?.info;
      if (!info) continue;
      const amount = Number(info.tokenAmount?.uiAmount ?? 0);
      if (amount <= 0) continue;
      out.push({
        mint: info.mint,
        amount,
        decimals: Number(info.tokenAmount?.decimals ?? 0),
        raw: info.tokenAmount?.amount ?? '0',
      });
    }
  }
  return out;
}

/** UI amount of one mint held by one owner. */
export async function getMintBalance(owner, mint) {
  try {
    const result = await rpc('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    let total = 0;
    for (const account of result?.value ?? []) {
      total += Number(account.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * A wallet counts as fresh when it has no transaction history, no SOL and
 * no token accounts.
 */
export async function inspectFreshness(address) {
  const [signatures, lamports, tokens] = await Promise.all([
    rpc('getSignaturesForAddress', [address, { limit: 1 }]).catch(() => []),
    getSolBalance(address).catch(() => 0),
    getTokenBalances(address).catch(() => []),
  ]);
  const reasons = [];
  if (Array.isArray(signatures) && signatures.length > 0) reasons.push('wallet already has transaction history');
  if (lamports > 0) reasons.push('wallet already holds SOL');
  if (tokens.length > 0) reasons.push('wallet already holds tokens');
  return { fresh: reasons.length === 0, reasons };
}

/** Signatures for an address, newest first, stopping at `untilSignature`. */
export async function getSignaturesSince(address, untilSignature, limit = 1000) {
  const params = [address, untilSignature ? { until: untilSignature, limit } : { limit }];
  const result = await rpc('getSignaturesForAddress', params).catch(() => []);
  return Array.isArray(result) ? result : [];
}

export async function getParsedTransaction(signature) {
  return rpc('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]).catch(() => null);
}

/** Decimals for a mint, so raw amounts can be turned into real ones. */
export async function getMintDecimals(mint) {
  const result = await rpc('getTokenSupply', [mint]);
  return Number(result?.value?.decimals ?? 0);
}

/**
 * Every holder of a mint, using Helius's getTokenAccounts. It pages 1,000 at a
 * time and costs far less than scanning the token program. Works on the free
 * plan; only available on Helius endpoints.
 */
export async function getMintHoldersViaDas(mint) {
  const decimals = await getMintDecimals(mint);
  const divisor = Math.pow(10, decimals);
  const holders = new Map();
  let cursor;
  let pages = 0;

  while (pages < 200) {
    const params = { mint, limit: 1000, options: { showZeroBalance: false } };
    if (cursor) params.cursor = cursor;

    const result = await rpc('getTokenAccounts', params);
    const accounts = result?.token_accounts ?? [];
    if (!accounts.length) break;

    for (const account of accounts) {
      const amount = Number(account.amount ?? 0) / divisor;
      if (amount <= 0 || !account.owner) continue;
      holders.set(account.owner, (holders.get(account.owner) ?? 0) + amount);
    }

    cursor = result?.cursor;
    pages += 1;
    if (!cursor) break;
    await sleep(120); // stay inside the free plan's rate limit
  }

  return holders;
}

/**
 * Every holder of a mint, via getProgramAccounts. Fallback for non-Helius
 * endpoints; the public endpoint usually refuses it.
 */
export async function getMintHolders(mint) {
  const holders = new Map();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    let result;
    try {
      result = await rpc('getProgramAccounts', [
        programId,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          filters: [{ memcmp: { offset: 0, bytes: mint } }],
        },
      ]);
    } catch (err) {
      if (programId === TOKEN_PROGRAM) throw err;
      continue;
    }
    for (const account of result ?? []) {
      const info = account.account?.data?.parsed?.info;
      if (!info) continue;
      const amount = Number(info.tokenAmount?.uiAmount ?? 0);
      if (amount <= 0) continue;
      holders.set(info.owner, (holders.get(info.owner) ?? 0) + amount);
    }
  }
  return holders;
}

export { SOL_MINT };
