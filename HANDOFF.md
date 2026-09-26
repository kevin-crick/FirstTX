# FirstTX — handoff brief

Paste this into a new chat to pick up where the last one left off.

---

## What this is

**FirstTX** is a daily Solana trading competition. Traders enter with a
brand-new wallet that has zero on-chain history, fund it with up to $1,000,
trade for 24 hours, and a live leaderboard ranks them by dollar profit. The top
three split a prize pot — a share of the coin's creator fees — **in proportion
to their profit** (e.g. $5,000 / $3,000 / $2,000 → 50% / 30% / 20%). Only
wallets in profit get paid; if nobody is up, the pot rolls over.

X account: **@tryfirsttx**. Site: **firsttx.trade** (custom domain on Netlify;
`www.` redirects to it; **firsttx.netlify.app** still works). Solana only.
Every address the site is served from must be listed in Railway's
`ALLOWED_ORIGINS`, or the pages load but show no data and the admin page
cannot unlock.

## Rules as built

- **Entry:** the holder wallet connects and signs a message, proving it held
  **$25 of the coin** at the snapshot taken when registration opens. One entry
  per holder wallet per round. The **competition wallet address is pasted in**,
  not connected — no second signature (the owner deliberately chose this).
- The competition wallet must have **no transactions, no SOL, no tokens** at
  registration. This is enforced live against mainnet.
- **No deposit window and no deadline.** The first money into the wallet is the
  starting balance. Funding split across transactions within 15 minutes counts
  as one deposit. Later top-ups are flagged for review, not auto-rejected.
- The **$1,000 cap is not enforced by code** — it is checked by hand at the end
  of the round. This was a deliberate decision to keep sign-up easy.
- People **can enter mid-round**; they just have less time left.
- Scoring: **PnL = wallet value − opening deposit**, updated every minute.
  Positions over $150 are re-checked with a real Jupiter sell quote and the
  lower value wins, so illiquid bags cannot inflate a score. **At the end only
  SOL and stablecoins count**, so positions must be closed.
- Swaps count as trades. Fees, validator tips, rent and airdrops are ignored.
- **Rounds are started and stopped by hand** from the admin page. No fixed
  clock. Each round runs 24 hours from the moment Start is pressed.

## Where everything lives

- **Project folder:** `C:\Users\gener\Desktop\FirstTX` — this is the only copy
  that matters. Open this folder at the start of the new chat.
- **Frontend** (plain HTML/CSS/JS, no build step): `index.html` (video hero
  landing page), `leaderboard.html`, `wallet.html`, `history.html`,
  `enter.html`, `rules.html`, `faq.html`, `admin.html`, shared `pages.css` and
  `app.js`, plus `logo.png` / `favicon.png`.
- **Backend:** `backend/` — Node 22, **zero dependencies** (uses the built-in
  `node:sqlite`, `fetch` and `crypto`). Entry point `backend/src/server.js`.
  See `backend/README.md` for the full API and settings reference.
- **Hosting:** site on **Netlify** (auto-deploys from GitHub `main`), backend on
  **Railway** at `https://firsttx-production.up.railway.app` with Root
  Directory `backend` and a volume at `/app/data`.
- **Deploying:** commit and push in **GitHub Desktop**; both services rebuild.
- **Secrets** live in `backend/.env` (git-ignored) and in Railway's Variables
  tab: `RPC_URL` (Helius), `ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `PORT`.
  **Never paste these into chat.**

## Testing

`cd backend` then:

- `npm start` — runs the server on port 8787
- `npm run check` — confirms Solana RPC, Jupiter prices and quotes work
- `node src/scripts/selftest.js` — **22 tests**, all passing on 2026-09-26.
  Start the server with `RATE_LIMIT_PER_MINUTE=100` first, or 4 of them trip
  the anti-spam limit. **Do not run it against production** — it registers
  throwaway wallets that would show on the real leaderboard.
- `node src/scripts/inspect-wallet.js <address>` — values any wallet
- `node src/scripts/replay-wallet.js` — replays real mainnet transactions
  through the trade classifier

## State right now

Everything is built and tested: registration, freshness checks, minute-by-minute
scoring, the leaderboard, wallet pages with profit charts, share cards, past
rounds with payout links, automatic pot calculation from fees, and an admin
panel with round control, pot setting, the review list and a WIPE button that
resets to round 001.

**Fixed on 2026-09-26 (needs pushing in GitHub Desktop if not yet done):**

- pump.fun and PumpSwap trades were read as *withdrawals*, so memecoin
  traders showed 0 trades and a withdrawal flag. Swaps are now recognised from
  the wallet's own balance changes, on every venue.
- The end-of-round "only SOL and stablecoins count" pass was being skipped for
  any wallet priced in the last 5 minutes (nearly all of them). Fixed.
- Admin page: new **Record payout** button on each winner in the review list
  (asks for the amount and the Solscan link). Recording again replaces it.
- Past rounds page: a top-three wallet with no profit now says "not in profit"
  instead of "payout pending".

**Still to do, in this order:**

1. **Push the fixes** (GitHub Desktop → Commit to main → Push origin).
2. **Admin token** was rotated on 2026-09-26 (but then pasted into chat once).
   **Helius key rotation skipped by choice.** If the leaderboard ever stops
   updating, check the Helius dashboard for used-up credits first; the fix is
   a new key in Railway's `RPC_URL` and `backend\.env`.
3. **A dry run with real money** (~$10), funded **in SOL**: enter, fund, make
   a couple of swaps (one on pump.fun), start the round, end it, review.
   Scoring has never been proven on a real funded wallet.
4. **Wipe** from the admin page afterwards so launch starts at round 001.
   (Production was already clean — round 001, 0 entries — on 2026-09-26.)
5. **When the coin launches**, add to Railway Variables: `COIN_MINT`,
   `FEE_WALLET`, `POT_PERCENT`, then press **Deploy** on the banner Railway
shows for unapplied changes. Creator fees only
   count toward the pot once they *arrive* in the fee wallet, so on pump.fun
   claim them during the round.
6. **Add a payment method to Railway** — the $5 trial will lapse.
7. **Netlify free credits ran out once already** and skipped deploys. If it
   happens again, options are Cloudflare Pages (free), serving the site from
   Railway, or Netlify Pro at $20/month.
8. Optional: a terms/disclaimer line on the rules page.

## How to work with me

The owner is not a developer. Explain things plainly, avoid jargon, and give
click-by-click instructions with exact file paths and button names. Do the work
rather than handing over commands to run. Test against live data rather than
assuming, and say plainly when something fails. Keep the site's look as it is:
dark (#050505), Manrope, minimal, lots of space, white pill buttons, soft green
for profit and soft red for loss.
