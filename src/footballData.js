// football-data.org client + background sync.
// Free plan: 10 requests/minute. Each sync run makes at most one request per competition.
import { getDb, getMeta, setMeta, nowIso } from './db.js';
import { settleMatch, reopenVoidedBets, SETTLE_STATUSES, VOID_STATUSES } from './bets.js';

export const COMPETITIONS = ['PL', 'CL'];
const API = 'https://api.football-data.org/v4';
const FINAL_STATUSES = [...SETTLE_STATUSES, ...VOID_STATUSES];
const DAY = 24 * 60 * 60 * 1000;
// How far back syncActive looks for unfinished matches. Bounds the request's date span, so one
// match the API never finalises (suspended, dropped) can't make every sync fetch a growing range.
const ACTIVE_LOOKBACK_DAYS = 10;

export function hasApiKey() {
  return Boolean(process.env.FOOTBALL_DATA_API_KEY);
}

const ymd = (d) => d.toISOString().slice(0, 10);

/** Fetch one competition's matches between two dates (inclusive). */
export async function fetchMatches(competition, from, to) {
  const url = `${API}/competitions/${competition}/matches?dateFrom=${ymd(from)}&dateTo=${ymd(to)}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`football-data.org ${res.status} for ${competition}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.matches ?? [];
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

/**
 * Matches from the last ACTIVE_LOOKBACK_DAYS that have kicked off but are not settled yet
 * (live, just finished, finished without a score yet, or missed while the laptop was off).
 * Re-fetch the date span they cover, one request per competition.
 */
export function activeSpans(now = Date.now()) {
  const ph = (list) => list.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT competition, MIN(kickoff_utc) AS first, MAX(kickoff_utc) AS last
              FROM matches
              WHERE kickoff_utc <= ? AND kickoff_utc >= ?
                AND (status NOT IN (${ph(FINAL_STATUSES)})
                     OR (status IN (${ph(SETTLE_STATUSES)}) AND home_score IS NULL))
              GROUP BY competition`)
    .all(new Date(now).toISOString(), new Date(now - ACTIVE_LOOKBACK_DAYS * DAY).toISOString(),
      ...FINAL_STATUSES, ...SETTLE_STATUSES);
}

export async function syncActive() {
  const active = activeSpans();
  let settled = 0;
  for (const a of active) {
    const ms = await fetchMatches(a.competition, new Date(a.first), new Date(Math.max(Date.parse(a.last), Date.now())));
    settled += upsertMatches(ms);
  }
  return { competitions: active.length, settled };
}

/** One scheduler tick: always check active matches; refresh upcoming every 6 hours. */
export async function syncTick({ force = false } = {}) {
  if (!hasApiKey()) {
    setMeta('last_sync_error', 'FOOTBALL_DATA_API_KEY is not set in .env');
    return;
  }
  try {
    const last = getMeta('last_upcoming_sync');
    if (force || !last || Date.now() - Date.parse(last) > 6 * 60 * 60 * 1000) {
      const r = await syncUpcoming();
      console.log(`[sync] upcoming: ${r.count} matches, ${r.settled} bets settled`);
    }
    const a = await syncActive();
    if (a.competitions) console.log(`[sync] active: ${a.competitions} competition(s) checked, ${a.settled} bets settled`);
    setMeta('last_sync_ok', nowIso());
    setMeta('last_sync_error', null);
  } catch (err) {
    console.error('[sync] failed:', err.message);
    setMeta('last_sync_error', err.message);
  }
}

export function startScheduler() {
  syncTick({ force: true }); // catch up at startup
  return setInterval(() => syncTick(), 5 * 60 * 1000);
}
