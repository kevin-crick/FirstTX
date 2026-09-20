# FirstTX backend

Runs the daily competition: registration, wallet checks, scoring every 5
minutes, end-of-round ranking, and the admin review that happens before a pot
is paid.

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

Run the rule tests (the server must be running):

```bash
node src/scripts/selftest.js
```

## Settings that matter

| Setting | What it does |
|---|---|
| `RPC_URL` | Solana access. **Get a Helius key before launch.** The public endpoint is rate limited and refuses the holder-snapshot call. |
| `COIN_MINT` | Your coin. Until it is set, the $25 holding rule is skipped and entries are marked unverified. |
| `ADMIN_TOKEN` | Long random string. Without it every admin endpoint is disabled. |
| `ALLOWED_ORIGINS` | Your Netlify site, so browsers elsewhere cannot call the API. |
| `MIN_HOLD_USD`, `DEPOSIT_CAP_USD` | $25 and $1,000. |
| `DUST_TRANSFER_USD` | Transfers under this are treated as fees and tips, not withdrawals. |

## How a round runs

| Time (UTC) | What happens |
|---|---|
| 12:00 the day before | Registration opens; the holder snapshot is taken |
| 00:00 | Round starts, deposit window opens |
| 01:00 | Deposits close, field locked |
| 01:00–24:00 | Wallets re-scored every 5 minutes |
| 24:00 | Final pass (cash only), ranks and pot shares frozen, status `review` |

Rounds are created automatically. Nothing needs to be started by hand.

## Scoring

PnL is the wallet's value minus its opening deposit, in dollars.

Holdings are priced through Jupiter, and any position worth more than $150 is
re-checked with a **real sell quote**, with the lower number winning. A token
with a pretty chart and no buyers is therefore worth what it is really worth.
At the end of the round only SOL and stablecoins count, so positions have to be
closed.

Deposits, withdrawals and trades are read from the wallet's transactions.
Swaps count as trades. Fees, validator tips and rent are ignored. Unsolicited
airdrops are ignored.

## Rule breaks

Recorded as flags for the manual review rather than automatic removal:

- `extra-deposit` — money arrived after the deposit window
- `withdrawal` — a real transfer left the wallet
- `dust-outflow` — many small transfers adding up
- `over-cap` — opening deposit above $1,000

The review endpoint also lists **wallets funded from the same source**, which is
how multiple entries from one person usually show up.

## API

Public:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/round` | Current round, phase, pot, wallet count |
| GET | `/api/leaderboard` | Ranked entries (`?round=`, `?sort=pnl\|roi\|trades`) |
| GET | `/api/wallet/:address` | One wallet, with its PnL history |
| GET | `/api/nonce` | Nonce to sign |
| POST | `/api/register` | Two wallets, two signatures |

Admin (send `Authorization: Bearer <ADMIN_TOKEN>`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/review` | Top 10 with deposits, funders, flags, transfers |
| POST | `/api/admin/disqualify` | `{entryId, reason}` — re-ranks the round |
| POST | `/api/admin/pot` | `{round, potUsd}` — set the pot shown on the site |
| POST | `/api/admin/finalize` | Freeze ranks and shares |
| POST | `/api/admin/payout` | `{entryId, signature, amountUsd}` — record a payout |
| POST | `/api/admin/snapshot` | Re-run the holder snapshot |

## Tools

| Command | What it does |
|---|---|
| `npm run check` | Confirms RPC, prices, quotes and the snapshot call work |
| `node src/scripts/selftest.js` | Tests the rules against a running server |
| `node src/scripts/inspect-wallet.js <address>` | Values any wallet the way the leaderboard does |
| `node src/scripts/replay-wallet.js [address]` | Replays real transactions through the classifier |
| `node src/scripts/dev-register.js` | Registers a throwaway wallet pair |

## Deploying

The API needs a machine that stays running, so it cannot live on Netlify.
Netlify keeps serving the website; the API goes on Railway, Fly.io, Render or a
small VPS.

1. Push this folder to a repository (`.env` and `data/` are git-ignored).
2. Create the service, set the environment variables from `.env.example`.
3. Start command: `npm start`. No build step.
4. Attach a persistent volume mounted where `data/` lives, or the database is
   lost on every redeploy.
5. Put your API's address in `ALLOWED_ORIGINS`, and set the same address as
   `API_BASE` in the website's `app.js`.

## Before launch

- Get a **Helius RPC key**. The holder snapshot does not work without one.
- Set `COIN_MINT` once the coin is live.
- Set a real `ADMIN_TOKEN`.
- Decide the pot percentage and post it with `/api/admin/pot` each round.
- Back up `data/firsttx.db`: it holds every entry and result.

## Not built yet

- Automatic pot calculation from coin fees (set by hand for now)
- Per-wallet page on the website (the API is ready: `/api/wallet/:address`)
- Round history and a hall of fame
- Email or Telegram alerts when a flag appears
