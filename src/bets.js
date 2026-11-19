// Bet and record queries, plus display helpers.
import { getDb, nowIso, tx } from './db.js';
import { resultFor, profitCents } from './settle.js';

export const OPEN_STATUSES = ['SCHEDULED', 'TIMED'];
export const SETTLE_STATUSES = ['FINISHED'];
export const VOID_STATUSES = ['POSTPONED', 'CANCELLED', 'AWARDED'];

/** A match is open for new bets / edits until its kickoff. */
export function isMatchOpen(match, now = new Date()) {
  return OPEN_STATUSES.includes(match.status) && new Date(match.kickoff_utc) > now;
}

const BET_SELECT = `
  SELECT b.*, u.display_name, u.username,
         m.home_team, m.away_team, m.kickoff_utc, m.status AS match_status,
         m.home_score, m.away_score, m.competition, m.competition_name
  FROM bets b
  JOIN users u ON u.id = b.user_id
  JOIN matches m ON m.id = b.match_id`;

export function getBet(id) {
  return getDb().prepare(`${BET_SELECT} WHERE b.id = ?`).get(id);
}

export function betsForMatch(matchId) {
  return getDb().prepare(`${BET_SELECT} WHERE b.match_id = ? ORDER BY b.created_at`).all(matchId);
}

export function betsForUser(userId) {
  return getDb().prepare(`${BET_SELECT} WHERE b.user_id = ? ORDER BY m.kickoff_utc DESC, b.created_at DESC`).all(userId);
}

const FEED_FILTERS = {
  all: '',
  pending: "WHERE b.result = 'PENDING'",
  settled: "WHERE b.result <> 'PENDING'",
};

export function feed(tab, page, perPage = 20) {
  const where = FEED_FILTERS[tab] ?? '';
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) AS n FROM bets b ${where}`).get().n;
  const rows = d
    .prepare(`${BET_SELECT} ${where} ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`)
    .all(perPage, (page - 1) * perPage);
  return { rows, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

/** W/L record for every user, keyed by user id. Same rules as settle.summarise, done in SQL. */
export function allRecords() {
  const rows = getDb()
    .prepare(
      `SELECT u.id,
         COUNT(b.id) AS total,
         COUNT(CASE WHEN b.result IN ('WON', 'HALF_WON') THEN 1 END) AS wins,
         COUNT(CASE WHEN b.result IN ('LOST', 'HALF_LOST') THEN 1 END) AS losses,
         COUNT(CASE WHEN b.result = 'PENDING' THEN 1 END) AS pending,
         COALESCE(SUM(b.profit_cents), 0) AS netCents
       FROM users u
       LEFT JOIN bets b ON b.user_id = u.id
       GROUP BY u.id`
    )
    .all();
  const out = {};
  for (const { id, ...rec } of rows) out[id] = rec;
  return out;
}

/** Identity of a selection, used to group duplicate bets on the same match. */
export function selectionKey(b) {
  switch (b.bet_type) {
    case '1X2':
      return `1X2|${b.pick}`;
    case 'AH':
    case 'OU':
      return `${b.bet_type}|${b.pick}|${Number(b.line)}`;
    case 'CS':
      return `CS|${b.cs_home}-${b.cs_away}`;
    default:
      return `OTHER|${String(b.other_text ?? '').trim().toLowerCase()}`;
  }
}

/** Group a match's bets by selection: [{ key, label, bets, people: [{name, count}] }]. */
export function groupBets(bets, match) {
  const groups = new Map();
  for (const b of bets) {
    const key = selectionKey(b);
    if (!groups.has(key)) groups.set(key, { key, type: b.bet_type, label: selectionLabel(b, match), bets: [] });
    groups.get(key).bets.push(b);
  }
  const typeOrder = { '1X2': 0, AH: 1, OU: 2, CS: 3, OTHER: 4 };
  return [...groups.values()]
    .map((g) => {
      const people = new Map(); // keyed by user id: display names are not unique
      for (const b of g.bets) {
        const p = people.get(b.user_id) ?? { name: b.display_name, count: 0 };
        p.count++;
        people.set(b.user_id, p);
      }
      return { ...g, people: [...people.values()] };
    })
    .sort((a, b) => b.bets.length - a.bets.length || typeOrder[a.type] - typeOrder[b.type]);
}

export function formatLine(line) {
  const n = Number(line);
  if (n === 0) return '0';
  return (n > 0 ? '+' : '−') + Math.abs(n);
}

export const TYPE_NAMES = {
  '1X2': '1X2',
  AH: 'Asian Handicap',
  OU: 'Total Goals',
  CS: 'Correct Score',
  OTHER: 'Other',
};

/** Human label for a bet's selection, e.g. "Arsenal −1.5" or "Over 2.5 goals". */
export function selectionLabel(b, match = b) {
  const home = match.home_team;
  const away = match.away_team;
  switch (b.bet_type) {
    case '1X2':
      return b.pick === 'DRAW' ? 'Draw' : `${b.pick === 'HOME' ? home : away} to win`;
    case 'AH':
      return `${b.pick === 'HOME' ? home : away} ${formatLine(b.line)}`;
    case 'OU':
      return `${b.pick === 'OVER' ? 'Over' : 'Under'} ${Number(b.line)} goals`;
    case 'CS':
      return `Correct score ${b.cs_home}–${b.cs_away}`;
    default:
      return b.other_text;
  }
}

/** Find bets on this match that share the selection of `candidate` (for the duplicate notice). */
export function duplicatesOf(candidate, matchId, excludeId = null) {
  const key = selectionKey(candidate);
  return betsForMatch(matchId).filter((b) => b.id !== excludeId && selectionKey(b) === key);
}

export function createBet(userId, matchId, f, createdAt = nowIso()) {
  const info = getDb()
    .prepare(
      `INSERT INTO bets (user_id, match_id, bet_type, pick, line, cs_home, cs_away, other_text,
                         odds_100, stake_cents, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, matchId, f.bet_type, f.pick, f.line, f.cs_home, f.cs_away, f.other_text,
      f.odds_100, f.stake_cents, f.description, createdAt, createdAt);
  return Number(info.lastInsertRowid);
}

export function updateBet(id, f) {
  getDb()
    .prepare(
      `UPDATE bets SET bet_type = ?, pick = ?, line = ?, cs_home = ?, cs_away = ?, other_text = ?,
                       odds_100 = ?, stake_cents = ?, description = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(f.bet_type, f.pick, f.line, f.cs_home, f.cs_away, f.other_text, f.odds_100, f.stake_cents,
      f.description, nowIso(), id);
}

export function updateDescription(id, description) {
  getDb().prepare('UPDATE bets SET description = ?, updated_at = ? WHERE id = ?').run(description, nowIso(), id);
}

export function deleteBet(id) {
  getDb().prepare('DELETE FROM bets WHERE id = ?').run(id);
}

function writeResult(bet, result) {
  getDb()
    .prepare('UPDATE bets SET result = ?, profit_cents = ?, settled_at = ? WHERE id = ?')
    .run(result, profitCents(result, bet.stake_cents, bet.odds_100), nowIso(), bet.id);
}

/** Owner settles an OTHER bet. */
export function settleOtherBet(bet, result) {
  writeResult(bet, result);
}

/**
 * Settle every pending bet on a match according to its status.
 * FINISHED -> auto-settle (OTHER bets wait for their owner); POSTPONED/CANCELLED/AWARDED -> VOID.
 * Returns the number of bets settled.
 */
export function settleMatch(match) {
  const pending = getDb().prepare("SELECT * FROM bets WHERE match_id = ? AND result = 'PENDING'").all(match.id);
  if (!pending.length) return 0;
  let n = 0;
  tx(() => {
    for (const bet of pending) {
      if (VOID_STATUSES.includes(match.status)) {
        writeResult(bet, 'VOID');
        n++;
      } else if (SETTLE_STATUSES.includes(match.status) && bet.bet_type !== 'OTHER' && match.home_score != null) {
        writeResult(bet, resultFor(bet, match.home_score, match.away_score));
        n++;
      }
    }
  });
  return n;
}

/**
 * A postponed match that comes back with a new kickoff is open again: bets voided by the
 * postponement go back to pending so they settle on the rescheduled game.
 * (Owners only settle "Other" bets on FINISHED matches, so any VOID here came from a postponement.)
 * Returns the number of bets reopened.
 */
export function reopenVoidedBets(match) {
  if (!OPEN_STATUSES.includes(match.status)) return 0;
  const info = getDb()
    .prepare("UPDATE bets SET result = 'PENDING', profit_cents = NULL, settled_at = NULL WHERE match_id = ? AND result = 'VOID'")
    .run(match.id);
  return Number(info.changes);
}

export const RESULT_LABELS = {
  PENDING: 'Pending',
  WON: 'Won',
  HALF_WON: 'Half won',
  LOST: 'Lost',
  HALF_LOST: 'Half lost',
  PUSH: 'Push',
  VOID: 'Void',
};
