// Pure settlement + money logic. No database access here, so it is easy to test.
//
// A bet is settled on the 90-minute score. Asian Handicap and Over/Under support
// whole lines (can push), half lines (always win/lose) and quarter lines (stake
// split across the two neighbouring lines -> half win / half loss).

export const BET_TYPES = ['1X2', 'AH', 'OU', 'CS', 'OTHER'];
export const FINAL_RESULTS = ['WON', 'HALF_WON', 'LOST', 'HALF_LOST', 'PUSH', 'VOID'];

// Outcome of a single (non-quarter) line: 1 = win, 0 = push, -1 = lose.
function lineOutcome(margin) {
  if (margin > 0) return 1;
  if (margin < 0) return -1;
  return 0;
}

// Split a line into its component lines. Quarter lines (x.25 / x.75) become two.
export function splitLine(line) {
  const q = Math.round(line * 4);
  if (Math.abs(q) % 2 === 1) return [(q - 1) / 4, (q + 1) / 4];
  return [q / 4];
}

export function isValidLine(line) {
  return Number.isFinite(line) && Math.abs(line * 4 - Math.round(line * 4)) < 1e-9;
}

// Margin for one component line, given the 90-minute score.
function marginFor(bet, line, home, away) {
  if (bet.bet_type === 'AH') {
    const diff = bet.pick === 'HOME' ? home - away : away - home;
    return diff + line;
  }
  if (bet.bet_type === 'OU') {
    const total = home + away;
    return bet.pick === 'OVER' ? total - line : line - total;
  }
  throw new Error(`marginFor: unsupported bet type ${bet.bet_type}`);
}

// Combine component-line outcomes (each covering an equal share of the stake).
function combine(outcomes) {
  if (outcomes.length === 1) return { 1: 'WON', 0: 'PUSH', [-1]: 'LOST' }[outcomes[0]];
  const sum = outcomes[0] + outcomes[1];
  if (sum === 2) return 'WON';
  if (sum === 1) return 'HALF_WON';
  if (sum === -1) return 'HALF_LOST';
  if (sum === -2) return 'LOST';
  return 'PUSH'; // win + lose on adjacent lines cannot happen with integer goals, but be safe
}

/**
 * Work out the result of an automatically-settled bet from the 90-minute score.
 * Returns one of WON | HALF_WON | LOST | HALF_LOST | PUSH.
 * OTHER bets are settled by their owner, so they throw here.
 */
export function resultFor(bet, home, away) {
  if (!Number.isInteger(home) || !Number.isInteger(away)) throw new Error('resultFor: score required');
  switch (bet.bet_type) {
    case '1X2': {
      const actual = home > away ? 'HOME' : home < away ? 'AWAY' : 'DRAW';
      return bet.pick === actual ? 'WON' : 'LOST';
    }
    case 'CS':
      return bet.cs_home === home && bet.cs_away === away ? 'WON' : 'LOST';
    case 'AH':
    case 'OU':
      return combine(splitLine(bet.line).map((l) => lineOutcome(marginFor(bet, l, home, away))));
    default:
      throw new Error(`resultFor: ${bet.bet_type} bets are settled by their owner`);
  }
}

/** Net profit in cents for a result. Win: stake x (odds - 1). Loss: -stake. */
export function profitCents(result, stakeCents, odds100) {
  const winCents = (stake) => Math.round((stake * (odds100 - 100)) / 100);
  switch (result) {
    case 'WON':
      return winCents(stakeCents);
    case 'HALF_WON':
      return winCents(stakeCents / 2);
    case 'LOST':
      return -stakeCents;
    case 'HALF_LOST':
      return -Math.round(stakeCents / 2);
    case 'PUSH':
    case 'VOID':
      return 0;
    default:
      return null; // PENDING
  }
}

/** Summarise a list of bets into a W/L record. Half wins count as W, half losses as L. */
export function summarise(bets) {
  const rec = { wins: 0, losses: 0, pending: 0, netCents: 0, total: bets.length };
  for (const b of bets) {
    if (b.result === 'WON' || b.result === 'HALF_WON') rec.wins++;
    else if (b.result === 'LOST' || b.result === 'HALF_LOST') rec.losses++;
    else if (b.result === 'PENDING') rec.pending++;
    if (b.profit_cents != null) rec.netCents += b.profit_cents;
  }
  return rec;
}
