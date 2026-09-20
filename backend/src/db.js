/* SQLite storage using Node's built-in driver — no native build step. */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rounds (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            INTEGER NOT NULL UNIQUE,
  snapshot_at       INTEGER NOT NULL,
  opens_at          INTEGER NOT NULL,
  deposit_closes_at INTEGER NOT NULL,
  ends_at           INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'upcoming',
  snapshot_status   TEXT    NOT NULL DEFAULT 'pending',
  snapshot_holders  INTEGER NOT NULL DEFAULT 0,
  pot_usd           REAL    NOT NULL DEFAULT 0,
  coin_mint         TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_holders (
  round_id   INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  owner      TEXT    NOT NULL,
  ui_amount  REAL    NOT NULL,
  usd_value  REAL    NOT NULL,
  PRIMARY KEY (round_id, owner)
);

CREATE TABLE IF NOT EXISTS entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id         INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  comp_wallet      TEXT    NOT NULL,
  holder_wallet    TEXT    NOT NULL,
  registered_at    INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'active',
  hold_verified    INTEGER NOT NULL DEFAULT 0,
  hold_usd         REAL    NOT NULL DEFAULT 0,
  deposit_usd      REAL    NOT NULL DEFAULT 0,
  deposit_sol      REAL    NOT NULL DEFAULT 0,
  first_funder     TEXT,
  first_deposit_at INTEGER,
  value_usd        REAL    NOT NULL DEFAULT 0,
  cash_usd         REAL    NOT NULL DEFAULT 0,
  pnl_usd          REAL    NOT NULL DEFAULT 0,
  roi_pct          REAL    NOT NULL DEFAULT 0,
  trades           INTEGER NOT NULL DEFAULT 0,
  last_signature   TEXT,
  indexed_at       INTEGER,
  final_rank       INTEGER,
  pot_share_pct    REAL,
  dq_reason        TEXT,
  UNIQUE (round_id, comp_wallet),
  UNIQUE (round_id, holder_wallet)
);

CREATE INDEX IF NOT EXISTS entries_round_idx ON entries (round_id, status);

CREATE TABLE IF NOT EXISTS valuations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id  INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  value_usd REAL    NOT NULL,
  pnl_usd   REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS valuations_entry_idx ON valuations (entry_id, ts);

CREATE TABLE IF NOT EXISTS flags (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id  INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  kind      TEXT    NOT NULL,
  detail    TEXT,
  signature TEXT,
  ts        INTEGER NOT NULL,
  UNIQUE (entry_id, kind, signature)
);

CREATE TABLE IF NOT EXISTS transfers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  signature  TEXT    NOT NULL,
  direction  TEXT    NOT NULL,
  counterpny TEXT,
  mint       TEXT,
  amount     REAL,
  usd        REAL,
  block_time INTEGER,
  UNIQUE (entry_id, signature, direction, mint)
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL,
  share_pct  REAL    NOT NULL,
  amount_usd REAL,
  signature  TEXT,
  recorded_at INTEGER NOT NULL
);
`);

export const now = () => Math.floor(Date.now() / 1000);

export const queryAll = (sql, ...params) => db.prepare(sql).all(...params);
export const queryOne = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);
