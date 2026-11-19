// Request helpers and bet-form parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { safeNext, parseBetForm } = await import('../src/app.js');

test('safeNext only allows same-site paths', () => {
  assert.equal(safeNext('/matches/1'), '/matches/1');
  assert.equal(safeNext('//evil.example/login'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext(undefined), '/');
  assert.equal(safeNext(['/a', '/b']), '/');
});

const base = { odds: '2.00', stake: '10' };

test('whitespace-only handicap / goal lines are rejected, not read as 0', () => {
  assert.equal(parseBetForm({ ...base, bet_type: 'AH', pick_ah: 'HOME', line_ah: ' ' }).errors.length, 1);
  assert.equal(parseBetForm({ ...base, bet_type: 'OU', pick_ou: 'OVER', line_ou: '  ' }).errors.length, 1);
  const ok = parseBetForm({ ...base, bet_type: 'AH', pick_ah: 'HOME', line_ah: ' -0.75 ' });
  assert.deepEqual([ok.errors, ok.fields.line], [[], -0.75]);
});

test('correct score needs a digit 0–9 on each side', () => {
  assert.equal(parseBetForm({ ...base, bet_type: 'CS', cs_home: ' ', cs_away: '1' }).errors.length, 1);
  assert.equal(parseBetForm({ ...base, bet_type: 'CS', cs_home: '1e0', cs_away: '1' }).errors.length, 1);
  const ok = parseBetForm({ ...base, bet_type: 'CS', cs_home: ' 2', cs_away: '0' });
  assert.deepEqual([ok.errors, ok.fields.cs_home, ok.fields.cs_away], [[], 2, 0]);
});

test('array values from repeated form fields do not crash parsing', () => {
  assert.equal(parseBetForm({ ...base, bet_type: 'OTHER', other_text: ['a', 'b'] }).errors.length, 0);
});

test('handicap and goal lines copied from the page (typographic minus) are accepted', () => {
  const ah = parseBetForm({ ...base, bet_type: 'AH', pick_ah: 'AWAY', line_ah: '−1.5' });
  assert.deepEqual([ah.errors, ah.fields.line], [[], -1.5]);
  const dash = parseBetForm({ ...base, bet_type: 'AH', pick_ah: 'AWAY', line_ah: '–0.25' });
  assert.deepEqual([dash.errors, dash.fields.line], [[], -0.25]);
  const plus = parseBetForm({ ...base, bet_type: 'AH', pick_ah: 'HOME', line_ah: '+0.25' });
  assert.deepEqual([plus.errors, plus.fields.line], [[], 0.25]);
  assert.equal(parseBetForm({ ...base, bet_type: 'AH', pick_ah: 'HOME', line_ah: '−' }).errors.length, 1);
});
