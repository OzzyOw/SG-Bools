// Random demo-bet helpers shared by the seed and add-pending scripts.
import { getDb } from '../src/db.js';
import { createBet } from '../src/bets.js';

const HOUR = 60 * 60 * 1000;

export const rnd = (min, max) => min + Math.random() * (max - min);
export const rint = (min, max) => Math.floor(rnd(min, max + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[0][0];
};
const odds100 = (min, max) => Math.round(rnd(min, max) * 20) * 5; // steps of 0.05

const STAKES = [500, 1000, 1000, 1000, 2000, 2000, 3000, 5000, 5000, 10000]; // cents
const AH_LINES = [-2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5];
const OU_LINES = [1.5, 2, 2.25, 2.5, 2.5, 2.5, 2.75, 3, 3.5];
const OTHERS = [
  'Both teams to score', 'Penalty awarded', 'Red card shown', 'Home team scores first',
  'Goal in both halves', 'Over 9.5 corners', 'Clean sheet for the away side',
];
const REASONS = [
  'Strong home form lately.', 'Their defence has been leaking goals.', 'Key striker is back from injury.',
  'Value odds — bookies are underrating them.', 'Derby games are always tight.', 'Gut feeling, honestly.',
  'They need the points more.', 'Rotation expected after midweek game.', 'Head-to-head record favours this.',
  'Saw the team news, looks good.', 'Last 5 meetings all had goals.', 'Away side tired after travel.',
  'Small punt for fun.', 'Following Dad on this one.', 'Weather should slow the game down.',
];

/** Random selection fields for one bet. */
export function randomSelection() {
  const type = weighted([['1X2', 40], ['AH', 25], ['OU', 25], ['CS', 6], ['OTHER', 4]]);
  switch (type) {
    case '1X2': {
      const p = weighted([['HOME', 45], ['DRAW', 22], ['AWAY', 33]]);
      // Picks are random (no real pre-match odds on the free API), so keep odds modest
      // or every random punter ends up in profit.
      const range = { HOME: [1.4, 2.6], DRAW: [3.0, 3.6], AWAY: [1.8, 3.4] }[p];
      return { bet_type: type, pick: p, odds_100: odds100(...range) };
    }
    case 'AH':
      return { bet_type: type, pick: pick(['HOME', 'AWAY']), line: pick(AH_LINES), odds_100: odds100(1.75, 2.15) };
    case 'OU':
      return { bet_type: type, pick: pick(['OVER', 'UNDER']), line: pick(OU_LINES), odds_100: odds100(1.75, 2.15) };
    case 'CS':
      return { bet_type: type, cs_home: weighted([[0, 3], [1, 4], [2, 3], [3, 1]]), cs_away: weighted([[0, 3], [1, 4], [2, 2], [3, 1]]), odds_100: odds100(5.5, 11) };
    default:
      return { bet_type: type, other_text: pick(OTHERS), odds_100: odds100(1.6, 4.5) };
  }
}

export function makeBet(base, overrides = {}) {
  return {
    pick: null, line: null, cs_home: null, cs_away: null, other_text: null,
    ...base,
    stake_cents: pick(STAKES),
    description: Math.random() < 0.6 ? pick(REASONS) : null,
    ...overrides,
  };
}

/**
 * Add `perMember` pending bets for every member on matches that are still open
 * (kickoff more than 2 hours away). About 1 in 5 copies another member's pending
 * bet on the same match, so duplicate grouping shows up. Returns the number added.
 */
export function addPendingBets(perMember) {
  const db = getDb();
  const now = Date.now();
  const users = db.prepare('SELECT id FROM users ORDER BY id').all();
  const open = db
    .prepare("SELECT * FROM matches WHERE status IN ('SCHEDULED','TIMED') AND kickoff_utc > ? ORDER BY kickoff_utc")
    .all(new Date(now + 2 * HOUR).toISOString());
  if (!open.length) throw new Error('No open upcoming matches in the database — start the app once to refresh matches.');

  const placed = []; // { userId, matchId, sel }
  let added = 0;
  for (let round = 0; round < perMember; round++) {
    for (const u of users) {
      const others = placed.filter((p) => p.userId !== u.id);
      let match;
      let sel;
      if (Math.random() < 0.2 && others.length) {
        const src = pick(others);
        match = open.find((m) => m.id === src.matchId);
        sel = { ...src.sel };
      } else {
        match = pick(open);
        sel = randomSelection();
      }
      // Posted sometime in the last day (always before kickoff, since kickoff is in the future).
      const createdAt = new Date(now - rnd(0.2, 24) * HOUR).toISOString();
      createBet(u.id, match.id, makeBet(sel), createdAt);
      placed.push({ userId: u.id, matchId: match.id, sel });
      added++;
    }
  }
  return added;
}
