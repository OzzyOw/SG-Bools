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
copy .env.example .env      # then put your football-data.org key in .env
npm run seed                 # demo members, ~140 settled bets (last 30 days) + ~40 pending bets
npm start                    # http://localhost:3000
```

Get a free API key at <https://www.football-data.org/client/register> (email only, no card).
Keep it in `.env` — football-data.org's terms forbid committing it.

`npm start` also prints a `same Wi-Fi` address; phones on your home network can open that.

### Demo logins

| Username | Password |
|---|---|
| mum | mum123 |
| dad | dad123 |
| bro | bro123 |
| sis | sis123 |
| cousin | cousin123 |
| me | me123 |

New members register at `/register` with the invite code from `.env` (`INVITE_CODE`, default `bools2026`).

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the app (plus background match refresh) |
| `npm run seed` | **Wipes** the database at `DB_PATH` and fills it with demo data. Stops without changing anything if the API key is missing. |
| `npm run add-pending -- <n>` | Add `n` pending demo bets per member (default 5) on open upcoming matches, without wiping anything |
| `npm run demo:record` | With the app running, records a ~1 min captioned demo with click sounds to `demo/sg-bools-demo.webm` (uses installed Microsoft Edge; leaves the data as it found it) |
| `npm test` | Settlement / money / sync tests (Node's built-in test runner) |
| `npm run reset-password -- <username> <new-password>` | Reset a forgotten password |

### `.env` settings

| Key | Purpose |
|---|---|
| `FOOTBALL_DATA_API_KEY` | football-data.org key |
| `INVITE_CODE` | Code needed to register |
| `SESSION_SECRET` | Signs the login cookie |
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
src/bets.js          bet queries, grouping, settlement against the DB
src/settle.js        pure settlement + money maths
src/footballData.js  football-data.org client + sync
src/db.js            SQLite schema and helpers
src/format.js        SGT dates, money formatting
views/               EJS pages
public/style.css     styling
scripts/seed.js      demo data
test/                node:test tests
```

## Known demo shortcuts (deliberate — this is a local proof of concept)

- **Passwords are stored in plain text.** Don't reuse a real password here.
- No CSRF protection, no login rate limiting; sessions live in memory, so restarting the server
  logs everyone out.
- No email — forgotten passwords are reset with the script above.
- Odds aren't available on the free API, so members type them in.
