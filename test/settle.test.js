import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultFor, profitCents, splitLine, isValidLine, summarise } from '../src/settle.js';

const ah = (pick, line) => ({ bet_type: 'AH', pick, line });
const ou = (pick, line) => ({ bet_type: 'OU', pick, line });

test('1X2', () => {
  assert.equal(resultFor({ bet_type: '1X2', pick: 'HOME' }, 2, 1), 'WON');
  assert.equal(resultFor({ bet_type: '1X2', pick: 'HOME' }, 1, 1), 'LOST');
  assert.equal(resultFor({ bet_type: '1X2', pick: 'DRAW' }, 0, 0), 'WON');
  assert.equal(resultFor({ bet_type: '1X2', pick: 'AWAY' }, 0, 3), 'WON');
  assert.equal(resultFor({ bet_type: '1X2', pick: 'AWAY' }, 3, 0), 'LOST');
});

test('Correct score', () => {
  assert.equal(resultFor({ bet_type: 'CS', cs_home: 2, cs_away: 1 }, 2, 1), 'WON');
  assert.equal(resultFor({ bet_type: 'CS', cs_home: 2, cs_away: 1 }, 1, 2), 'LOST');
  assert.equal(resultFor({ bet_type: 'CS', cs_home: 0, cs_away: 0 }, 0, 0), 'WON');
});

test('Asian handicap: half lines never push', () => {
  assert.equal(resultFor(ah('HOME', -1.5), 2, 0), 'WON');
  assert.equal(resultFor(ah('HOME', -1.5), 1, 0), 'LOST');
  assert.equal(resultFor(ah('AWAY', 1.5), 1, 0), 'WON'); // away +1.5, loses by 1
  assert.equal(resultFor(ah('AWAY', 0.5), 1, 1), 'WON');
});

test('Asian handicap: whole lines push', () => {
  assert.equal(resultFor(ah('HOME', -1), 2, 1), 'PUSH');
  assert.equal(resultFor(ah('HOME', -1), 3, 1), 'WON');
  assert.equal(resultFor(ah('HOME', 0), 1, 1), 'PUSH');
  assert.equal(resultFor(ah('AWAY', 0), 1, 2), 'WON');
  assert.equal(resultFor(ah('AWAY', 1), 2, 1), 'PUSH');
});

test('Asian handicap: quarter lines give half results', () => {
  // -0.25 = half on 0, half on -0.5
  assert.equal(resultFor(ah('HOME', -0.25), 1, 1), 'HALF_LOST');
  assert.equal(resultFor(ah('HOME', -0.25), 1, 0), 'WON');
  // -0.75 = half on -0.5, half on -1
  assert.equal(resultFor(ah('HOME', -0.75), 1, 0), 'HALF_WON');
  assert.equal(resultFor(ah('HOME', -0.75), 2, 0), 'WON');
  assert.equal(resultFor(ah('HOME', -0.75), 0, 0), 'LOST');
  // +0.25 on away = half on 0, half on +0.5
  assert.equal(resultFor(ah('AWAY', 0.25), 2, 2), 'HALF_WON');
  // +1.25 on away: loses by 1 -> half on +1 push, half on +1.5 win
  assert.equal(resultFor(ah('AWAY', 1.25), 1, 0), 'HALF_WON');
  // +1.25 on away: loses by 2 -> half on +1 lose, half on +1.5 lose
  assert.equal(resultFor(ah('AWAY', 1.25), 2, 0), 'LOST');
});

test('Over/Under: half, whole and quarter lines', () => {
  assert.equal(resultFor(ou('OVER', 2.5), 2, 1), 'WON');
  assert.equal(resultFor(ou('OVER', 2.5), 1, 1), 'LOST');
  assert.equal(resultFor(ou('UNDER', 2.5), 1, 1), 'WON');
  assert.equal(resultFor(ou('OVER', 2), 1, 1), 'PUSH');
  assert.equal(resultFor(ou('UNDER', 3), 2, 1), 'PUSH');
  // 2.75 = half on 2.5, half on 3
  assert.equal(resultFor(ou('OVER', 2.75), 2, 1), 'HALF_WON');
  assert.equal(resultFor(ou('UNDER', 2.75), 2, 1), 'HALF_LOST');
  assert.equal(resultFor(ou('OVER', 2.75), 3, 1), 'WON');
  // 2.25 = half on 2, half on 2.5
  assert.equal(resultFor(ou('OVER', 2.25), 1, 1), 'HALF_LOST');
  assert.equal(resultFor(ou('UNDER', 2.25), 1, 1), 'HALF_WON');
  assert.equal(resultFor(ou('UNDER', 2.25), 0, 1), 'WON');
});

test('OTHER bets cannot be auto-settled', () => {
  assert.throws(() => resultFor({ bet_type: 'OTHER' }, 1, 0));
});

test('splitLine and isValidLine', () => {
  assert.deepEqual(splitLine(-0.75), [-1, -0.5]);
  assert.deepEqual(splitLine(2.25), [2, 2.5]);
  assert.deepEqual(splitLine(-1.5), [-1.5]);
  assert.deepEqual(splitLine(0), [0]);
  assert.ok(isValidLine(1.25));
  assert.ok(!isValidLine(1.3));
});

test('Profit maths in cents', () => {
  // $10 at 2.10
  assert.equal(profitCents('WON', 1000, 210), 1100);
  assert.equal(profitCents('HALF_WON', 1000, 210), 550);
  assert.equal(profitCents('LOST', 1000, 210), -1000);
  assert.equal(profitCents('HALF_LOST', 1000, 210), -500);
  assert.equal(profitCents('PUSH', 1000, 210), 0);
  assert.equal(profitCents('VOID', 1000, 210), 0);
  assert.equal(profitCents('PENDING', 1000, 210), null);
  // rounding: $3.33 at 1.95 -> 3.33 * 0.95 = 3.1635 -> 316 cents
  assert.equal(profitCents('WON', 333, 195), 316);
  // half of odd stake: $3.33 half loss -> 167 cents (rounded)
  assert.equal(profitCents('HALF_LOST', 333, 195), -167);
});

test('summarise: half results count as W/L, push and void count as neither', () => {
  const rec = summarise([
    { result: 'WON', profit_cents: 1100 },
    { result: 'HALF_WON', profit_cents: 550 },
    { result: 'LOST', profit_cents: -1000 },
    { result: 'HALF_LOST', profit_cents: -500 },
    { result: 'PUSH', profit_cents: 0 },
    { result: 'VOID', profit_cents: 0 },
    { result: 'PENDING', profit_cents: null },
  ]);
  assert.deepEqual(rec, { wins: 2, losses: 2, pending: 1, netCents: 150, total: 7 });
});
