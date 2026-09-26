# FirstTX backend

Runs the competition: registration, wallet checks, minute-by-minute scoring,
end-of-round ranking, and the review that happens before a pot is paid.

Solana only. No external packages — it runs on Node 22 alone, so there is no
install step and nothing to break at deploy time.

**It never holds keys and never moves money.** Payouts are sent by you, by
hand, and recorded afterwards.

---

## Running it

```bash
cd backend
copy .env.example .env      # then edit .env
npm start
```

Check the outside world is reachable:

```bash
npm run check
```

Run the rule tests (the server must be running, started with
`RATE_LIMIT_PER_MINUTE=100` so the test's sign-ups are not throttled — 22 tests):

```bash
node src/scripts/selftest.js
```

Do not point the self-test at the live server: it registers throwaway wallets,
which would then appear on the real leaderboard.

## Settings that matter

| Setting | What it does |
|---|---|
| `RPC_URL` | Solana access. Use a Helius key: the public endpoint is rate limited and refuses the holder-snapshot call. |
| `COIN_MINT` | Your coin. Until it is set, the $25 holding rule is skipped and entries are marked unverified. |
| `ADMIN_TOKEN` | Long random string. Without it every admin endpoint is disabled. |
| `ALLOWED_ORIGINS` | Your Netlify site, so browsers elsewhere cannot call the API. |
| `MIN_HOLD_USD` | $25 to qualify, checked against the holder snapshot. |
| `DEPOSIT_CAP_USD` | $1,000. Not enforced — checked by hand at review. |
| `INDEX_INTERVAL_SECONDS` | How often wallets are checked for new trades. Default 60. |
| `REVALUE_INTERVAL_SECONDS` | How often a quiet wallet is re-priced anyway. Default 300. |
| `DUST_TRANSFER_USD` | Transfers under this are fees and tips, not withdrawals. |

## How a round runs

Rounds are controlled from the admin page (`admin.html`), not by a clock.

| Step | What happens |
|---|---|
| **Open registration** | The holder snapshot is taken and entries open. No clock. |
| **Start 24 hour round** | The clock begins at that moment and scoring starts. |
| While running | Wallets are checked every minute. People can still enter. |
| 24 hours later | The round flips to review by itself, scores frozen (cash only). |
| **End round now** | Same thing, early, if you want to stop sooner. |

Only one round runs at a time; the API refuses to start a second.

## Entering

Two wallets, one signature:

- **Holder wallet** — connects and signs a message, proving it held $25 of the
  coin at the snapshot. One entry per holder wallet per round.
- **Competition wallet** — the address is pasted in, not connected. It must
  have no transactions, no SOL and no tokens. Entries are marked as unsigned so
  the review shows it.

## Scoring

PnL is the wallet's value minus its opening deposit, in dollars.

There is no deposit window. **The first money into the wallet is the starting
balance**, whenever it arrives; funding split across transactions within
`DEPOSIT_GRACE_SECONDS` counts as one deposit. Anything added later is flagged
for review rather than counted.

Holdings are priced through Jupiter, and any position worth more than $150 is
re-checked with a **real sell quote**, with the lower number winning. A token
with a pretty chart and no buyers is therefore worth what it is really worth.
At the end of the round only SOL and stablecoins count, so positions have to be
closed.

Swaps count as trades. A transaction is a swap when the wallet signed it and
its own balances show something went out and something else came in, so
pump.fun, PumpSwap, Raydium and Jupiter are all recognised without a list of
programs. Money sent in by another wallet that co-signed a swap is still a
deposit. Fees, validator tips and rent are ignored. Unsolicited airdrops are
ignored.

**Fund with SOL.** USDC sent with the older plain `transfer` instruction
carries no mint in the parsed data and would not be recognised as a deposit.
Most exchanges and wallets use `transferChecked`, which works, but SOL is the
safe instruction to give entrants.

**Cost control:** every minute each wallet costs one call to check for new
activity. Full re-pricing only happens when there are new trades, or every
`REVALUE_INTERVAL_SECONDS` otherwise.

## Rule breaks

Recorded as flags for the manual review rather than automatic removal:

- `extra-deposit` — money added after the opening deposit
- `withdrawal` — a real transfer left the wallet
- `dust-outflow` — many small transfers adding up
- `over-cap` — opening deposit above the cap

The review also lists **wallets funded from the same source**, which is how
multiple entries from one person usually show up.

## API

Public:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/round` | Current round, phase, pot, wallet count |
| GET | `/api/leaderboard` | Ranked entries (`?round=`, `?sort=pnl\|roi\|trades`) |
| GET | `/api/wallet/:address` | One wallet, with its PnL history |
| GET | `/api/nonce` | Nonce to sign |
| POST | `/api/register` | Holder signature plus a pasted competition address |

Admin (send `Authorization: Bearer <ADMIN_TOKEN>`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/admin/round/create` | Open registration and take the snapshot |
| POST | `/api/admin/round/start` | Start the round (`{hours}`, default 24) |
| POST | `/api/admin/round/end` | End the running round now |
| GET | `/api/admin/rounds/list` | Recent rounds with status and entry counts |
| GET | `/api/admin/review` | Top wallets with deposits, funders, flags, transfers |
| POST | `/api/admin/disqualify` | `{entryId, reason}` — re-ranks the round |
| POST | `/api/admin/pot` | `{round, potUsd}` — set the pot shown on the site |
| POST | `/api/admin/finalize` | Freeze ranks and shares |
| POST | `/api/admin/payout` | `{entryId, signature, amountUsd}` — record a payout (replaces any earlier one for that entry). The admin page's **Record payout** button calls this. |
| POST | `/api/admin/snapshot` | Re-run the holder snapshot |

## Tools

| Command | What it does |
|---|---|
| `npm run check` | Confirms RPC, prices, quotes and the snapshot call work |
| `node src/scripts/selftest.js [apiBase]` | Tests the rules against a running server |
| `node src/scripts/inspect-wallet.js <address>` | Values any wallet the way the leaderboard does |
| `node src/scripts/replay-wallet.js [address]` | Replays real transactions through the classifier |
| `node src/scripts/dev-register.js` | Registers a throwaway wallet pair |
| `node src/scripts/loadtest.js [wallets] [late] [minutes]` | A full round on its own database with brand-new wallets, live data, and a report in `data/`. Watch it at `http://localhost:5173/leaderboard.html`. |

## Deploying

The API needs a machine that stays running, so it does not belong on Netlify
alongside the site. It currently runs on Railway.

1. Push this folder to the repository (`.env` and `data/` are git-ignored).
2. Railway service → **Root Directory** must be `backend`.
3. Variables: `RPC_URL`, `ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `PORT`, and
   `COIN_MINT` once the coin exists.
4. Attach a volume mounted at `/app/data`, or the database is lost on redeploy.
5. The site's `app.js` points at the Railway address.

## Before launch

- Set `COIN_MINT`. Until then the $25 holding rule is skipped entirely.
- Rotate `ADMIN_TOKEN` and the Helius key if either has been shared.
- Set the pot each round from the admin page.
- Back up `data/firsttx.db`: it holds every entry and result.

## Automatic pot

With `FEE_WALLET` and `POT_PERCENT` set, every SOL, USDC or USDT payment that
lands in the fee wallet while a round is running adds to that round's pot.
Fees count when they **arrive** in the wallet: on pump.fun creator fees sit in
a vault until you claim them, so claim during the round for them to count.

## Not built yet

- Alerts when a flag appears
