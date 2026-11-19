// Owner settles an "Other" bet by hand, and can undo it for 24 hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { getDb } = await import('../src/db.js');
const { createBet, getBet, settleOtherBet, canUndoSettle, unsettleOtherBet, UNDO_SETTLE_MS } = await import('../src/bets.js');

const db = getDb();
const userId = Number(
  db.prepare("INSERT INTO users (username, display_name, password, created_at) VALUES ('u', 'U', 'x', '2026-01-01')").run().lastInsertRowid
);
db.prepare(
  `INSERT INTO matches (id, competition, competition_name, home_team, away_team, kickoff_utc, status, home_score, away_score, updated_at)
   VALUES (1, 'PL', 'Premier League', 'Home FC', 'Away FC', '2026-11-01T15:00:00Z', 'FINISHED', 1, 0, '2026-11-01T17:00:00Z')`
).run();

const other = () =>
  createBet(userId, 1, { bet_type: 'OTHER', pick: null, line: null, cs_home: null, cs_away: null, other_text: 'Red card', odds_100: 300, stake_cents: 1000, description: null });

test('a hand-settled Other bet can be undone back to pending', () => {
  const id = other();
  settleOtherBet(getBet(id), 'WON');
  const settled = getBet(id);
  assert.deepEqual([settled.result, settled.profit_cents], ['WON', 2000]);
  assert.equal(canUndoSettle(settled), true);

  unsettleOtherBet(settled);
  const back = getBet(id);
  assert.deepEqual([back.result, back.profit_cents, back.settled_at], ['PENDING', null, null]);
  assert.equal(canUndoSettle(back), false);
});

test('undo is only offered within 24 hours, on finished matches, for Other bets', () => {
  const id = other();
  settleOtherBet(getBet(id), 'LOST');
  const bet = getBet(id);
  const settledAt = Date.parse(bet.settled_at);
  assert.equal(canUndoSettle(bet, 'FINISHED', settledAt + UNDO_SETTLE_MS - 1000), true);
  assert.equal(canUndoSettle(bet, 'FINISHED', settledAt + UNDO_SETTLE_MS), false);
  // An Other bet voided because its match was postponed was not settled by hand.
  assert.equal(canUndoSettle({ ...bet, result: 'VOID' }, 'POSTPONED'), false);
  assert.equal(canUndoSettle({ ...bet, bet_type: '1X2' }), false);
});
