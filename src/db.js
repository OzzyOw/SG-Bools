// SQLite access using Node's built-in driver. One file, path from DB_PATH.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password     TEXT NOT NULL,            -- plain text on purpose: demo only (see README)
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id               INTEGER PRIMARY KEY,  -- football-data.org match id
  competition      TEXT NOT NULL,        -- 'PL' | 'CL'
  competition_name TEXT NOT NULL,
  stage            TEXT,
  matchday         INTEGER,
  home_team        TEXT NOT NULL,
  away_team        TEXT NOT NULL,
  kickoff_utc      TEXT NOT NULL,        -- ISO 8601, UTC
  status           TEXT NOT NULL,        -- football-data status (TIMED, IN_PLAY, FINISHED, ...)
  home_score       INTEGER,              -- 90-minute score (no extra time / penalties)
  away_score       INTEGER,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff_utc);

CREATE TABLE IF NOT EXISTS bets (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  bet_type     TEXT NOT NULL,            -- '1X2' | 'AH' | 'OU' | 'CS' | 'OTHER'
  pick         TEXT,                     -- HOME/DRAW/AWAY (1X2), HOME/AWAY (AH), OVER/UNDER (OU)
  line         REAL,                     -- AH handicap for the picked team, or OU goal line
  cs_home      INTEGER,
  cs_away      INTEGER,
  other_text   TEXT,
  odds_100     INTEGER NOT NULL,         -- odds x 100 (2.10 -> 210)
  stake_cents  INTEGER NOT NULL,         -- SGD cents
  description  TEXT,
  result       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|WON|HALF_WON|LOST|HALF_LOST|PUSH|VOID
  profit_cents INTEGER,                  -- null while pending
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  settled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_created ON bets(created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let db;

export function getDb() {
  if (db) return db;
  const file = process.env.DB_PATH || 'data/sgbools.db';
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function getMeta(key) {
  return getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

// Run fn inside a transaction.
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}
