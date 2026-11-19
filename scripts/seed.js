// Wipe the database at DB_PATH and fill it with demo data built on REAL matches.
//   npm run seed
// Needs FOOTBALL_DATA_API_KEY in .env (stops before touching anything if it's missing).
import { getDb, tx, nowIso, setMeta } from '../src/db.js';
import { fetchMatches, upsertMatches, ninetyMinuteScore, COMPETITIONS, hasApiKey } from '../src/footballData.js';
import { createBet, settleMatch, settleOtherBet } from '../src/bets.js';
import { rnd, rint, pick, weighted, randomSelection, makeBet, addPendingBets } from './demo-bets.js';

// Demo members — passwords are deliberately simple (and stored in plain text: demo only).
export const MEMBERS = [
  { username: 'mum', display_name: 'Mum', password: 'mum123' },
  { username: 'dad', display_name: 'Dad', password: 'dad123' },
  { username: 'bro', display_name: 'Bro', password: 'bro123' },
  { username: 'sis', display_name: 'Sis', password: 'sis123' },
  { username: 'cousin', display_name: 'Cousin', password: 'cousin123' },
  { username: 'me', display_name: 'Me', password: 'me123' },
];
const PENDING_PER_MEMBER = 7; // ~40 pending bets on real upcoming matches

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

if (!hasApiKey()) {
  console.error('Set FOOTBALL_DATA_API_KEY in .env first — sign up free at football-data.org. Nothing was changed.');
  process.exit(1);
}

// ---------- fetch real matches first (before wiping anything) ----------
const now = Date.now();
const apiMatches = [];
for (const c of COMPETITIONS) {
  console.log(`Fetching ${c} matches (last 30 days + next 7)...`);
  apiMatches.push(...(await fetchMatches(c, new Date(now - 30 * DAY), new Date(now + 7 * DAY))));
}

const since = now - 30 * DAY;
const finishedFromApi = apiMatches.filter(
  (m) => m.status === 'FINISHED' && ninetyMinuteScore(m.score)[0] != null && Date.parse(m.utcDate) >= since
);
if (!finishedFromApi.length) {
  console.error('No finished matches in the last 30 days came back from the API — cannot build settled bets. Nothing was changed.');
  process.exit(1);
}

// ---------- wipe + insert ----------
const db = getDb();
tx(() => {
  db.exec('DELETE FROM bets; DELETE FROM users; DELETE FROM matches; DELETE FROM meta;');
});
upsertMatches(apiMatches); // no bets yet, so nothing settles here
setMeta('last_upcoming_sync', nowIso());
setMeta('last_sync_ok', nowIso());

const users = MEMBERS.map((m) => {
  const info = db
    .prepare('INSERT INTO users (username, display_name, password, created_at) VALUES (?, ?, ?, ?)')
    .run(m.username, m.display_name, m.password, new Date(now - 45 * DAY).toISOString());
  return { ...m, id: Number(info.lastInsertRowid) };
});

const finished = db
  .prepare("SELECT * FROM matches WHERE status = 'FINISHED' AND home_score IS NOT NULL AND kickoff_utc >= ? ORDER BY kickoff_utc")
  .all(new Date(since).toISOString());

// Past bets: 20–25 per member. Sometimes copy a bet someone already made on the same match
// ("following a tip"), occasionally the same member buys the same bet twice.
const placed = []; // { userId, matchId, sel }
let settledCount = 0;
tx(() => {
  for (const u of users) {
    const n = rint(20, 25);
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      let match;
      let sel;
      const others = placed.filter((p) => p.userId !== u.id);
      const mine = placed.filter((p) => p.userId === u.id);
      if (roll < 0.25 && others.length) {
        const src = pick(others); // follow someone's tip
        match = finished.find((m) => m.id === src.matchId);
        sel = { ...src.sel, odds_100: Math.max(105, src.sel.odds_100 + pick([-5, 0, 0, 5])) };
      } else if (roll < 0.29 && mine.length) {
        const src = pick(mine); // bought the same bet twice
        match = finished.find((m) => m.id === src.matchId);
        sel = { ...src.sel };
      } else {
        match = pick(finished);
        sel = randomSelection();
      }
      const kickoff = Date.parse(match.kickoff_utc);
      const createdAt = new Date(kickoff - rnd(1, 48) * HOUR).toISOString();
      createBet(u.id, match.id, makeBet(sel), createdAt);
      placed.push({ userId: u.id, matchId: match.id, sel });
    }
  }
});

// Settle with the app's real settlement code. "Other" bets are settled by their owner in the app;
// here the seed plays the owner and marks them randomly.
for (const m of finished) settledCount += settleMatch(m);
for (const bet of db.prepare("SELECT * FROM bets WHERE bet_type = 'OTHER' AND result = 'PENDING'").all()) {
  settleOtherBet(bet, weighted([['WON', 45], ['LOST', 50], ['VOID', 5]]));
  settledCount++;
}

// Pending bets on real upcoming matches, the same number for every member.
let pendingCount = 0;
try {
  pendingCount = tx(() => addPendingBets(PENDING_PER_MEMBER));
} catch (err) {
  console.warn(`Skipped pending bets: ${err.message}`);
}

console.log(`\nSeeded ${users.length} members, ${apiMatches.length} matches (${finished.length} finished in the last 30 days).`);
console.log(`Bets: ${settledCount} settled, ${pendingCount} pending.`);
console.log('\nDemo logins (username / password):');
for (const m of MEMBERS) console.log(`  ${m.username.padEnd(7)} / ${m.password}`);
