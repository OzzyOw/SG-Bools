// Settlement through the sync path, against an in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { getDb } = await import('../src/db.js');
const { upsertMatches, ninetyMinuteScore, activeSpans } = await import('../src/footballData.js');
const { createBet, groupBets, betsForMatch, allRecords } = await import('../src/bets.js');
const { summarise } = await import('../src/settle.js');

const db = getDb();
const userId = Number(
  db.prepare("INSERT INTO users (username, display_name, password, created_at) VALUES ('t', 'T', 'x', '2026-01-01')").run().lastInsertRowid
);

const apiMatch = (id, status, score) => ({
  id, status, utcDate: '2026-11-01T15:00:00Z', stage: 'REGULAR_SEASON', matchday: 1,
  competition: { code: 'PL', name: 'Premier League' },
  homeTeam: { name: 'Home FC', shortName: 'Home' }, awayTeam: { name: 'Away FC', shortName: 'Away' },
  score,
});
const bet = (matchId, f) =>
  createBet(userId, matchId, { pick: null, line: null, cs_home: null, cs_away: null, other_text: null, odds_100: 200, stake_cents: 1000, description: null, ...f });
const get = (id) => db.prepare('SELECT result, profit_cents FROM bets WHERE id = ?').get(id);

test('ninetyMinuteScore prefers regularTime (extra time / penalties excluded)', () => {
  assert.deepEqual(ninetyMinuteScore({ fullTime: { home: 2, away: 1 } }), [2, 1]);
  assert.deepEqual(ninetyMinuteScore({ fullTime: { home: 3, away: 2 }, regularTime: { home: 1, away: 1 } }), [1, 1]);
  assert.deepEqual(ninetyMinuteScore({ fullTime: { home: null, away: null } }), [null, null]);
});

test('bets stay pending until the match is FINISHED, then settle automatically', () => {
  upsertMatches([apiMatch(1, 'TIMED', { fullTime: { home: null, away: null } })]);
  const win = bet(1, { bet_type: '1X2', pick: 'HOME' });
  const lose = bet(1, { bet_type: 'OU', pick: 'OVER', line: 3.5 });
  const half = bet(1, { bet_type: 'AH', pick: 'HOME', line: -0.75 });
  const other = bet(1, { bet_type: 'OTHER', other_text: 'Red card' });

  upsertMatches([apiMatch(1, 'IN_PLAY', { fullTime: { home: 1, away: 0 } })]);
  assert.equal(get(win).result, 'PENDING');

  upsertMatches([apiMatch(1, 'FINISHED', { fullTime: { home: 2, away: 1 } })]);
  assert.deepEqual({ ...get(win) }, { result: 'WON', profit_cents: 1000 });
  assert.deepEqual({ ...get(lose) }, { result: 'LOST', profit_cents: -1000 });
  assert.deepEqual({ ...get(half) }, { result: 'HALF_WON', profit_cents: 500 });
  assert.equal(get(other).result, 'PENDING'); // owner settles "Other"

  // A later sync with a corrected score does not re-settle already-settled bets.
  upsertMatches([apiMatch(1, 'FINISHED', { fullTime: { home: 0, away: 1 } })]);
  assert.equal(get(win).result, 'WON');
});

test('postponed and cancelled matches void every pending bet, including Other', () => {
  upsertMatches([apiMatch(2, 'TIMED', {}), apiMatch(3, 'TIMED', {})]);
  const a = bet(2, { bet_type: '1X2', pick: 'AWAY' });
  const b = bet(3, { bet_type: 'OTHER', other_text: 'Penalty' });
  upsertMatches([apiMatch(2, 'POSTPONED', {}), apiMatch(3, 'CANCELLED', {})]);
  assert.deepEqual({ ...get(a) }, { result: 'VOID', profit_cents: 0 });
  assert.deepEqual({ ...get(b) }, { result: 'VOID', profit_cents: 0 });
});

test('knockout match settled on the 90-minute score, not after extra time', () => {
  upsertMatches([apiMatch(4, 'TIMED', {})]);
  const draw = bet(4, { bet_type: '1X2', pick: 'DRAW' });
  upsertMatches([apiMatch(4, 'FINISHED', { duration: 'EXTRA_TIME', fullTime: { home: 2, away: 1 }, regularTime: { home: 1, away: 1 } })]);
  assert.equal(get(draw).result, 'WON');
});

test('a postponed match that is rescheduled reopens its voided bets, which then settle normally', () => {
  upsertMatches([apiMatch(5, 'TIMED', {})]);
  const a = bet(5, { bet_type: '1X2', pick: 'HOME' });
  upsertMatches([apiMatch(5, 'POSTPONED', {})]);
  assert.equal(get(a).result, 'VOID');
  upsertMatches([apiMatch(5, 'TIMED', {})]);
  assert.deepEqual({ ...get(a) }, { result: 'PENDING', profit_cents: null });
  upsertMatches([apiMatch(5, 'FINISHED', { fullTime: { home: 1, away: 0 } })]);
  assert.equal(get(a).result, 'WON');
});

test('activeSpans: finished-without-score stays active; old stuck matches drop out of the window', () => {
  const at = (id, status, utcDate, score = {}) => ({ ...apiMatch(id, status, score), utcDate, competition: { code: 'CL', name: 'Champions League' } });
  const now = Date.parse('2026-11-20T12:00:00Z');
  upsertMatches([
    at(10, 'FINISHED', '2026-11-19T20:00:00Z', { fullTime: { home: null, away: null } }), // no score yet
    at(11, 'SUSPENDED', '2026-10-01T20:00:00Z'), // stuck, outside the lookback
    at(12, 'FINISHED', '2026-11-18T20:00:00Z', { fullTime: { home: 1, away: 1 } }), // done
  ]);
  const cl = activeSpans(now).find((s) => s.competition === 'CL');
  assert.deepEqual({ first: cl.first, last: cl.last }, { first: '2026-11-19T20:00:00Z', last: '2026-11-19T20:00:00Z' });
});

test('allRecords and groupBets count members by id, not display name', () => {
  const twin = Number(
    db.prepare("INSERT INTO users (username, display_name, password, created_at) VALUES ('t2', 'T', 'x', '2026-01-01')").run().lastInsertRowid
  );
  upsertMatches([apiMatch(20, 'TIMED', {})]);
  bet(20, { bet_type: '1X2', pick: 'DRAW' });
  createBet(twin, 20, { pick: 'DRAW', line: null, cs_home: null, cs_away: null, other_text: null, odds_100: 300, stake_cents: 500, description: null, bet_type: '1X2' });
  const [g] = groupBets(betsForMatch(20), { home_team: 'Home', away_team: 'Away' });
  assert.deepEqual(g.people, [{ name: 'T', count: 1 }, { name: 'T', count: 1 }]);

  const recs = allRecords();
  const expected = summarise(db.prepare('SELECT result, profit_cents FROM bets WHERE user_id = ?').all(userId));
  assert.deepEqual({ ...recs[userId] }, expected);
  assert.deepEqual({ ...recs[twin] }, { total: 1, wins: 0, losses: 0, pending: 1, netCents: 0 });
});
