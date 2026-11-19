# SG Bools

A private, local-only web app where a family/friends group shares the soccer bets they've bought,
so everyone can follow a good tip, skip a duplicate, and see who's actually winning.

It **only records** bets placed elsewhere — it handles no money, places no bets, and is not
affiliated with Singapore Pools.

## Who it's for and why

- **Audience:** one private group of ~6 family members/friends who bet on football.
- **Problem:** tips get lost in chat, people unknowingly buy the same bet twice, and nobody knows
  whose tips are actually any good.
- **What it does:** members post bets on real EPL / Champions League matches (type, selection, odds,
  stake, why). Everyone sees everyone's bets; identical bets are grouped ("Man City −1.25 — Bro,
  Cousin ×2"); bets settle automatically from real scores, and every bet card shows the poster's
  record, e.g. `12W · 5L · 2 pending · +$42.50`.

## Setup

Needs **Node 22.13+** (built and tested on Node 26). No database server — SQLite is built into Node.

```
npm install
copy .env.example .env      # then fill in .env (see below)
npm run seed                 # demo members, ~140 settled bets (last 30 days) + ~40 pending bets
npm start                    # http://localhost:3000
```

In `.env`, set:

- `FOOTBALL_DATA_API_KEY` — get a free key at <https://www.football-data.org/client/register>
  (email only, no card). Keep it in `.env`: football-data.org's terms forbid committing it.
- `SESSION_SECRET` — a long random string. The server **won't start** while it is missing or
  `change-me`. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `INVITE_CODE` — your group's own code. `/register` stays **off** until it's set (the old
  example `bools2026` counts as unset).

### Phones on the same Wi-Fi

By default the app only accepts connections from this computer. To let phones on your home
network in, add `HOST=0.0.0.0` to `.env`; `npm start` then prints a `same Wi-Fi` address.
Traffic is plain HTTP, so passwords and the login cookie cross the Wi-Fi unencrypted — only do
this on a network you trust, and never with the demo logins below.

### Logins

`npm run seed` gives each demo member (`mum`, `dad`, `bro`, `sis`, `cousin`, `me`) a random
password and prints them **once** at the end; they're stored hashed, so note them down.

`npm run seed:demo` instead uses simple published passwords, for screenshots and
`npm run demo:record` on this computer only (the server warns if you expose them with `HOST`):

| Username | Password |
|---|---|
| mum | mum123 |
| dad | dad123 |
| bro | bro123 |
| sis | sis123 |
| cousin | cousin123 |
| me | me123 |

New members register at `/register` with the invite code from `.env`. Passwords need at least
8 characters and display names must be unique.

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the app (plus background match refresh) |
| `npm run seed` | **Wipes** the database at `DB_PATH` and fills it with demo data; members get random passwords, printed once. Stops without changing anything if the API key is missing. |
| `npm run seed:demo` | Same, but with the simple published demo passwords (this computer only) |
| `npm run add-pending -- <n>` | Add `n` pending demo bets per member (default 5) on open upcoming matches, without wiping anything |
| `npm run demo:record` | With the app running on `seed:demo` data, records a ~1 min captioned demo with click sounds to `demo/sg-bools-demo.webm` (uses installed Microsoft Edge; leaves the data as it found it) |
| `npm test` | Settlement / money / sync / security tests (Node's built-in test runner) |
| `npm run reset-password -- <username>` | Reset a forgotten password (asks for the new one at a hidden prompt; logs that member out everywhere) |
| `npm run remove-member -- <username>` | Permanently delete a member who has left, with all their bets (asks you to confirm) |

### `.env` settings

| Key | Purpose |
|---|---|
| `FOOTBALL_DATA_API_KEY` | football-data.org key |
| `INVITE_CODE` | Code needed to register (registration is off until set) |
| `SESSION_SECRET` | Signs the login cookie (required; long and random) |
| `HOST` | Unset = this computer only; `0.0.0.0` = also phones on the same network |
| `DB_PATH` | SQLite file (default `data/sgbools.db`) |
| `PORT` | Default 3000 |

## How it works

- **Stack:** Node + Express, server-rendered EJS pages, plain JavaScript, SQLite via `node:sqlite`.
- **Match data:** football-data.org free plan, EPL (`PL`) and Champions League (`CL`).
  Upcoming fixtures (next 7 days) refresh every 6 hours and at startup; matches that have kicked
  off but aren't final are checked every 5 minutes. On startup it catches up on anything missed
  while the laptop was off. If the API is down the app keeps working from saved data and the
  footer says when data was last updated. Free-plan scores are delayed, so settlement lags full
  time a little.
- **Bet types:** 1X2, Asian Handicap, Total Goals Over/Under, Correct Score, Other (free text).
- **Locking:** bets can only be posted, edited or deleted before kickoff. After kickoff only the
  description can change. The server enforces this and ownership on every request.
- **Settlement** (`src/settle.js`): on the 90-minute score (no extra time or penalties).
  Whole lines can **push** (stake back); quarter lines (e.g. −0.75, 2.25) split the stake, giving
  **half won** (counts as W, half profit) or **half lost** (counts as L, lose half stake).
  Postponed / cancelled matches void their bets. "Other" bets are settled by their owner.
- **Record:** W = won + half won, L = lost + half lost; pushes and voids count as neither.
  Net = sum of profit (win: stake × (odds − 1); loss: −stake).

## Project layout

```
src/server.js        start server + scheduler
src/app.js           routes, login, bet form validation
src/auth.js          password hashing, attempt limits, config checks
src/bets.js          bet queries, grouping, settlement against the DB
src/settle.js        pure settlement + money maths
src/footballData.js  football-data.org client + sync
src/db.js            SQLite schema and helpers
src/format.js        SGT dates, money formatting
views/               EJS pages
public/style.css     styling
scripts/seed.js      demo data
scripts/*.js         reset-password, remove-member and other admin scripts
test/                node:test tests
```

## Security and privacy

- **Passwords** are hashed with scrypt and a random salt per member (`src/auth.js`); databases
  from older versions are converted on startup.
- **Logins** are limited to 10 wrong attempts per device per 15 minutes; wrong invite codes and
  wrong current passwords on the Account page are limited too. The limits live in memory.
- **Sessions** last 30 days from the last visit. Changing or resetting a password logs that
  member out on every other device. Cross-site form posts are rejected (Origin/Referer check)
  and the cookie is `HttpOnly` + `SameSite=Lax`.
- **Leaving:** members can delete their own account and all their bets from the Account page;
  `npm run remove-member` does the same for someone who has left.
- Sync error details are shown only to logged-in members, and never include the API's response.

### Still deliberate shortcuts (local proof of concept)

- Plain HTTP, no TLS: keep it on a trusted home network.
- Sessions live in memory, so restarting the server logs everyone out.
- No email — forgotten passwords are reset with the script above.
- Odds aren't available on the free API, so members type them in.
