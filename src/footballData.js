// football-data.org client + background sync.
// Free plan: 10 requests/minute. A sync run makes one request per competition with unsettled
// recent matches, plus one per IDS_PER_REQUEST older matches that still have pending bets.
import { getDb, getMeta, setMeta, nowIso } from './db.js';
import { settleMatch, reopenVoidedBets, SETTLE_STATUSES, VOID_STATUSES } from './bets.js';

export const COMPETITIONS = ['PL', 'CL'];
const API = 'https://api.football-data.org/v4';
const FINAL_STATUSES = [...SETTLE_STATUSES, ...VOID_STATUSES];
const DAY = 24 * 60 * 60 * 1000;
// How far back syncActive looks for unfinished matches by date. Bounds the request's date span, so
// one match the API never finalises (suspended, dropped) can't make every sync fetch a growing range.
// Older matches are only re-fetched (by id) while someone still has a pending bet on them.
const ACTIVE_LOOKBACK_DAYS = 10;
const IDS_PER_REQUEST = 20;
const REQUEST_TIMEOUT_MS = 20_000;

export function hasApiKey() {
  return Boolean(process.env.FOOTBALL_DATA_API_KEY);
}

const ymd = (d) => d.toISOString().slice(0, 10);

async function getMatches(url, label) {
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`football-data.org ${res.status} for ${label}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.matches ?? [];
}

/** Fetch one competition's matches between two dates (inclusive). */
export function fetchMatches(competition, from, to) {
  return getMatches(`${API}/competitions/${competition}/matches?dateFrom=${ymd(from)}&dateTo=${ymd(to)}`, competition);
}

/** Fetch specific matches by football-data.org id, whatever their date. */
export function fetchMatchesByIds(ids) {
  return getMatches(`${API}/matches?ids=${ids.join(',')}`, `matches ${ids.join(',')}`);
}

/** The 90-minute score: regularTime when the match went to extra time / penalties, else fullTime. */
export function ninetyMinuteScore(score) {
  const s = score?.regularTime ?? score?.fullTime;
  if (!s || s.home == null || s.away == null) return [null, null];
  return [s.home, s.away];
}

/** Insert or update matches from the API, then settle any that reached a final status. */
export function upsertMatches(apiMatches) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO matches (id, competition, competition_name, stage, matchday, home_team, away_team,
                         kickoff_utc, status, home_score, away_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      competition = excluded.competition, competition_name = excluded.competition_name,
      stage = excluded.stage, matchday = excluded.matchday,
      home_team = excluded.home_team, away_team = excluded.away_team,
      kickoff_utc = excluded.kickoff_utc, status = excluded.status,
      home_score = excluded.home_score, away_score = excluded.away_score,
      updated_at = excluded.updated_at`);
  let settled = 0;
  for (const m of apiMatches) {
    if (!m.homeTeam?.name || !m.awayTeam?.name) continue; // knockout slots with undecided teams
    const [hs, as] = ninetyMinuteScore(m.score);
    stmt.run(m.id, m.competition.code, m.competition.name, m.stage ?? null, m.matchday ?? null,
      m.homeTeam.shortName || m.homeTeam.name, m.awayTeam.shortName || m.awayTeam.name,
      m.utcDate, m.status, hs, as, nowIso());
    if (FINAL_STATUSES.includes(m.status)) {
      settled += settleMatch(d.prepare('SELECT * FROM matches WHERE id = ?').get(m.id));
    } else {
      reopenVoidedBets(m); // postponed match rescheduled
    }
  }
  return settled;
}

/** Upcoming fixtures: yesterday -> 7 days ahead, every competition. */
export async function syncUpcoming() {
  const now = Date.now();
  let count = 0;
  let settled = 0;
  for (const c of COMPETITIONS) {
    const ms = await fetchMatches(c, new Date(now - DAY), new Date(now + 7 * DAY));
    count += ms.length;
    settled += upsertMatches(ms);
  }
  setMeta('last_upcoming_sync', nowIso());
  return { count, settled };
}

const ph = (list) => list.map(() => '?').join(',');
// Kicked-off match whose bets can't settle yet: not final, or finished without a score.
const UNRESOLVED = `(m.status NOT IN (${ph(FINAL_STATUSES)})
                     OR (m.status IN (${ph(SETTLE_STATUSES)}) AND m.home_score IS NULL))`;
const UNRESOLVED_ARGS = [...FINAL_STATUSES, ...SETTLE_STATUSES];

/**
 * Matches from the last ACTIVE_LOOKBACK_DAYS that have kicked off but are not settled yet
 * (live, just finished, finished without a score yet, or missed while the laptop was off).
 * Re-fetch the date span they cover, one request per competition.
 */
export function activeSpans(now = Date.now()) {
  return getDb()
    .prepare(`SELECT competition, MIN(kickoff_utc) AS first, MAX(kickoff_utc) AS last
              FROM matches m
              WHERE kickoff_utc <= ? AND kickoff_utc >= ? AND ${UNRESOLVED}
              GROUP BY competition`)
    .all(new Date(now).toISOString(), new Date(now - ACTIVE_LOOKBACK_DAYS * DAY).toISOString(), ...UNRESOLVED_ARGS);
}

/**
 * Ids of unresolved matches of any age whose stored kickoff has passed and that still have
 * PENDING bets. Date-range requests can miss these: the laptop was off for longer than the
 * lookback, the API finalised a suspended match weeks later, or the fixture moved to a date
 * outside every window. Fetching them by id covers all three.
 */
export function stuckMatchIds(now = Date.now()) {
  return getDb()
    .prepare(`SELECT m.id FROM matches m
              WHERE m.kickoff_utc <= ? AND ${UNRESOLVED}
                AND EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id AND b.result = 'PENDING')
              ORDER BY m.kickoff_utc, m.id`)
    .all(new Date(now).toISOString(), ...UNRESOLVED_ARGS)
    .map((r) => r.id);
}

/**
 * Refresh kicked-off, unsettled matches: recent ones by date span per competition, then (by id)
 * any with pending bets that the spans did not return. A failing request doesn't stop the others;
 * the errors are returned for the caller to report.
 */
export async function syncActive(now = Date.now()) {
  let requests = 0;
  let settled = 0;
  const errors = [];
  const seen = new Set();
  const run = async (load) => {
    requests++;
    try {
      const ms = await load();
      for (const m of ms) seen.add(m.id);
      settled += upsertMatches(ms);
    } catch (err) {
      errors.push(err.message);
    }
  };

  for (const a of activeSpans(now)) {
    await run(() => fetchMatches(a.competition, new Date(a.first), new Date(Math.max(Date.parse(a.last), now))));
  }
  const stuck = stuckMatchIds(now).filter((id) => !seen.has(id));
  for (let i = 0; i < stuck.length; i += IDS_PER_REQUEST) {
    await run(() => fetchMatchesByIds(stuck.slice(i, i + IDS_PER_REQUEST)));
  }
  return { requests, settled, errors };
}

/** One scheduler tick: always check active matches; refresh upcoming every 6 hours. Never rejects. */
export async function syncTick({ force = false } = {}) {
  try {
    if (!hasApiKey()) {
      setMeta('last_sync_error', 'FOOTBALL_DATA_API_KEY is not set in .env');
      return;
    }
    const errors = [];
    const last = getMeta('last_upcoming_sync');
    if (force || !last || Date.now() - Date.parse(last) > 6 * 60 * 60 * 1000) {
      try {
        const r = await syncUpcoming();
        console.log(`[sync] upcoming: ${r.count} matches, ${r.settled} bets settled`);
      } catch (err) {
        errors.push(err.message); // still check active matches below
      }
    }
    const a = await syncActive();
    errors.push(...a.errors);
    if (a.requests) console.log(`[sync] active: ${a.requests} request(s), ${a.settled} bets settled`);
    if (errors.length) {
      for (const e of errors) console.error('[sync] failed:', e);
      setMeta('last_sync_error', errors.join(' | '));
    } else {
      setMeta('last_sync_ok', nowIso());
      setMeta('last_sync_error', null);
    }
  } catch (err) {
    console.error('[sync] failed:', err.message);
    try {
      setMeta('last_sync_error', err.message);
    } catch {
      // database unavailable too: nothing more to record this tick
    }
  }
}

export function startScheduler() {
  syncTick({ force: true }); // catch up at startup
  return setInterval(() => syncTick(), 5 * 60 * 1000);
}
