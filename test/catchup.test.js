// Catch-up of matches outside the sync date windows (issue #1), against an in-memory database
// and a stubbed fetch. Own file so it gets its own database.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.FOOTBALL_DATA_API_KEY = 'test-key';
const { getDb, getMeta } = await import('../src/db.js');
const { upsertMatches, stuckMatchIds, syncActive, syncTick } = await import('../src/footballData.js');
const { createBet, voidPendingBets, reopenVoidedBets } = await import('../src/bets.js');

const db = getDb();
const userId = Number(
  db.prepare("INSERT INTO users (username, display_name, password, created_at) VALUES ('t', 'T', 'x', '2026-01-01')").run().lastInsertRowid
);

const NOW = Date.parse('2026-11-20T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z');
const apiMatch = (id, status, utcDate, score = {}, code = 'PL') => ({
  id, status, utcDate, stage: 'REGULAR_SEASON', matchday: 1,
  competition: { code, name: code === 'PL' ? 'Premier League' : 'Champions League' },
  homeTeam: { name: 'Home FC', shortName: 'Home' }, awayTeam: { name: 'Away FC', shortName: 'Away' },
  score,
});
const bet = (matchId, f = { bet_type: '1X2', pick: 'HOME' }) =>
  createBet(userId, matchId, { pick: null, line: null, cs_home: null, cs_away: null, other_text: null, odds_100: 200, stake_cents: 1000, description: null, ...f });
const result = (id) => db.prepare('SELECT result FROM bets WHERE id = ?').get(id).result;
const kickoff = (id) => db.prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(id).kickoff_utc;

// Stub football-data.org: `api` maps match id -> current API state; `fail` lists URL fragments to 500.
let api;
let fail;
let calls;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  calls.push(url);
  if (fail.some((f) => url.includes(f))) return new Response('boom', { status: 500 });
  const u = new URL(url);
  let ms;
  if (u.searchParams.has('ids')) {
    const ids = u.searchParams.get('ids').split(',').map(Number);
    ms = ids.map((id) => api.get(id)).filter(Boolean);
  } else {
    const code = u.pathname.split('/')[3];
    const from = u.searchParams.get('dateFrom');
    const to = `${u.searchParams.get('dateTo')}T23:59:59Z`;
    ms = [...api.values()].filter((m) => m.competition.code === code && m.utcDate >= from && m.utcDate <= to);
  }
  return new Response(JSON.stringify({ matches: ms }), { status: 200 });
};
after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  db.exec('DELETE FROM bets; DELETE FROM matches; DELETE FROM meta;');
  api = new Map();
  fail = [];
  calls = [];
});

/** Store a match as the app last saw it, and set what the API says now. */
const seed = (stored, now = stored) => {
  upsertMatches([stored]);
  api.set(now.id, now);
};

test('stuckMatchIds: old unresolved matches with pending bets, of any age', () => {
  seed(apiMatch(1, 'TIMED', daysAgo(30))); // laptop was off: pending bet -> stuck
  seed(apiMatch(2, 'SUSPENDED', daysAgo(15))); // no bets -> left alone
  seed(apiMatch(3, 'TIMED', daysAgo(12))); // only settled bets -> left alone
  seed(apiMatch(4, 'FINISHED', daysAgo(20), { fullTime: { home: null, away: null } })); // no score yet
  seed(apiMatch(5, 'FINISHED', daysAgo(20), { fullTime: { home: 1, away: 0 } })); // pending Other: owner settles
  seed(apiMatch(6, 'TIMED', daysAgo(-2))); // not kicked off
  seed(apiMatch(7, 'IN_PLAY', daysAgo(0.05))); // live, recent
  for (const id of [1, 4, 6, 7]) bet(id);
  db.prepare("UPDATE bets SET result = 'WON' WHERE id = ?").run(bet(3));
  bet(5, { bet_type: 'OTHER', other_text: 'Red card' });

  assert.deepEqual(stuckMatchIds(NOW), [1, 4, 7]);
});

test('laptop off for weeks: a match outside the lookback is fetched by id and its bets settle', async () => {
  seed(apiMatch(1, 'TIMED', daysAgo(25)), apiMatch(1, 'FINISHED', daysAgo(25), { fullTime: { home: 2, away: 0 } }));
  seed(apiMatch(2, 'TIMED', daysAgo(25))); // no bets: not requested
  const b = bet(1);

  const r = await syncActive(NOW);
  assert.deepEqual(r, { requests: 1, settled: 1, errors: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/v4\/matches\?ids=1$/);
  assert.equal(result(b), 'WON');
  assert.deepEqual(stuckMatchIds(NOW), []);
});

test('suspended match finalised by the API weeks later still settles', async () => {
  seed(apiMatch(1, 'SUSPENDED', daysAgo(40)));
  const b = bet(1, { bet_type: 'OU', pick: 'UNDER', line: 2.5 });
  await syncActive(NOW);
  assert.equal(result(b), 'PENDING'); // API hasn't decided yet: keep asking

  api.set(1, apiMatch(1, 'FINISHED', daysAgo(40), { fullTime: { home: 1, away: 1 } }));
  await syncActive(NOW);
  assert.equal(result(b), 'WON');
});

test('fixture moved outside every window without POSTPONED: the id fetch picks up the new kickoff', async () => {
  seed(apiMatch(1, 'TIMED', daysAgo(1)), apiMatch(1, 'TIMED', daysAgo(-20)));
  const b = bet(1);

  await syncActive(NOW);
  assert.equal(kickoff(1), daysAgo(-20));
  assert.equal(result(b), 'PENDING');
  assert.deepEqual(stuckMatchIds(NOW), []); // back in the future: no more requests until kickoff
});

test('matches the date span already returned are not fetched again by id', async () => {
  seed(apiMatch(1, 'IN_PLAY', daysAgo(0.05)), apiMatch(1, 'FINISHED', daysAgo(0.05), { fullTime: { home: 0, away: 1 } }));
  seed(apiMatch(2, 'TIMED', daysAgo(20)), apiMatch(2, 'CANCELLED', daysAgo(20)));
  const a = bet(1);
  const b = bet(2);

  const r = await syncActive(NOW);
  assert.equal(r.requests, 2);
  assert.match(calls[0], /competitions\/PL\/matches\?dateFrom=/);
  assert.match(calls[1], /\/v4\/matches\?ids=2$/);
  assert.equal(result(a), 'LOST');
  assert.equal(result(b), 'VOID');
});

test('one failing competition does not block the others or the id catch-up', async () => {
  seed(apiMatch(1, 'IN_PLAY', daysAgo(0.05), {}, 'CL'));
  seed(apiMatch(2, 'IN_PLAY', daysAgo(0.05)), apiMatch(2, 'FINISHED', daysAgo(0.05), { fullTime: { home: 3, away: 0 } }));
  seed(apiMatch(3, 'TIMED', daysAgo(30)), apiMatch(3, 'FINISHED', daysAgo(30), { fullTime: { home: 1, away: 0 } }));
  bet(1);
  const pl = bet(2);
  const old = bet(3);
  fail = ['/competitions/CL/'];

  const r = await syncActive(NOW);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /500 for CL/);
  assert.equal(result(pl), 'WON');
  assert.equal(result(old), 'WON');
});

test('syncTick: a failing upcoming refresh still runs active sync and records the error', async () => {
  seed(apiMatch(1, 'TIMED', daysAgo(30)), apiMatch(1, 'FINISHED', daysAgo(30), { fullTime: { home: 1, away: 0 } }));
  const b = bet(1);
  fail = ['dateFrom='];
  const log = console.log;
  const error = console.error;
  console.log = console.error = () => {};
  try {
    await syncTick({ force: true });
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.equal(result(b), 'WON');
  assert.match(getMeta('last_sync_error'), /500 for PL/);
  assert.equal(getMeta('last_sync_ok'), null);
});

test('voidPendingBets voids every pending bet (Other too) and leaves settled ones', () => {
  upsertMatches([apiMatch(1, 'SUSPENDED', daysAgo(60))]);
  const a = bet(1);
  const o = bet(1, { bet_type: 'OTHER', other_text: 'Penalty' });
  const s = bet(1);
  db.prepare("UPDATE bets SET result = 'LOST', profit_cents = -1000 WHERE id = ?").run(s);

  assert.equal(voidPendingBets(1), 2);
  assert.equal(result(a), 'VOID');
  assert.equal(result(o), 'VOID');
  assert.equal(result(s), 'LOST');
  assert.deepEqual(stuckMatchIds(NOW), []); // nothing pending: no more requests

  // If the API later reschedules it, the bets come back like a postponement.
  reopenVoidedBets(apiMatch(1, 'TIMED', daysAgo(-3)));
  assert.equal(result(a), 'PENDING');
});
