/* Pricing.
   Two sources, on purpose:
     - Jupiter price API  : fast USD price for every mint held.
     - Jupiter quote API  : what a position would REALLY sell for, including
                            price impact. Used on positions worth more than
                            QUOTE_THRESHOLD_USD, and the lower of the two wins.
   That is what stops a thin token with a pretty chart from inflating a score. */

import { SOL_MINT, USDC_MINT, STABLES } from './config.js';

const PRICE_API = 'https://lite-api.jup.ag/price/v3';
const QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';

const QUOTE_THRESHOLD_USD = 150;
/* Never spend more than this many quote calls on one wallet in one pass. */
const MAX_QUOTES_PER_WALLET = 25;
/* Dust is not worth an API call. */
const DUST_USD = 1;
const PRICE_TTL_MS = 60_000;

const priceCache = new Map(); // mint -> { usdPrice, at }

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** USD prices for many mints at once. Returns Map(mint -> usdPrice). */
export async function getPrices(mints) {
  const now = Date.now();
  const out = new Map();
  const missing = [];

  for (const mint of new Set(mints)) {
    if (STABLES.has(mint)) {
      out.set(mint, 1);
      continue;
    }
    const cached = priceCache.get(mint);
    if (cached && now - cached.at < PRICE_TTL_MS) out.set(mint, cached.usdPrice);
    else missing.push(mint);
  }

  /* The API takes batches of ids. */
  for (let i = 0; i < missing.length; i += 40) {
    const batch = missing.slice(i, i + 40);
    const json = await fetchJson(`${PRICE_API}?ids=${batch.join(',')}`);
    for (const mint of batch) {
      const price = Number(json?.[mint]?.usdPrice);
      const value = Number.isFinite(price) ? price : 0;
      priceCache.set(mint, { usdPrice: value, at: now });
      out.set(mint, value);
    }
  }
  return out;
}

export async function getSolPrice() {
  const prices = await getPrices([SOL_MINT]);
  return prices.get(SOL_MINT) ?? 0;
}

/**
 * What selling `rawAmount` of `mint` into USDC would actually return, in USD.
 * Returns null when no route exists — an unsellable bag.
 */
export async function getSellQuoteUsd(mint, rawAmount) {
  if (mint === USDC_MINT) return Number(rawAmount) / 1e6;
  const amount = BigInt(rawAmount).toString();
  if (amount === '0') return 0;
  const url =
    `${QUOTE_API}?inputMint=${mint}&outputMint=${USDC_MINT}&amount=${amount}` +
    `&slippageBps=100&restrictIntermediateTokens=true`;
  const json = await fetchJson(url);
  const out = Number(json?.outAmount);
  if (!Number.isFinite(out)) return null;
  return out / 1e6; // USDC has 6 decimals
}

/**
 * Value a wallet's holdings the way the rules describe.
 * positions: [{ mint, amount, decimals, raw }]
 * Returns { totalUsd, cashUsd, positions: [...with usd and priced flag] }
 */
export async function valuePositions(positions) {
  const prices = await getPrices(positions.map((p) => p.mint));

  /* Price everything first, then spend quote calls on the biggest positions
     only — those are the ones where price impact actually changes a score. */
  const priced = positions.map((position) => {
    const price = prices.get(position.mint) ?? 0;
    return { ...position, usdPrice: price, usd: price * position.amount, source: 'price' };
  });

  const quoteTargets = new Set(
    priced
      .filter((p) => p.usd >= QUOTE_THRESHOLD_USD && !STABLES.has(p.mint))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, MAX_QUOTES_PER_WALLET)
      .map((p) => p),
  );

  const valued = [];
  for (const position of priced) {
    if (position.usd < DUST_USD) {
      valued.push({ ...position, usd: 0, source: 'dust' });
      continue;
    }
    if (!quoteTargets.has(position)) {
      valued.push(position);
      continue;
    }

    const quoted = await getSellQuoteUsd(position.mint, position.raw);
    if (quoted === null) {
      valued.push({ ...position, usd: 0, source: 'unsellable' }); // nothing will buy it
    } else if (quoted < position.usd) {
      valued.push({ ...position, usd: quoted, source: 'quote' }); // real exit is worse than the chart
    } else {
      valued.push({ ...position, source: 'quote-high' });
    }
  }

  const totalUsd = valued.reduce((sum, p) => sum + p.usd, 0);
  return { totalUsd, positions: valued };
}
