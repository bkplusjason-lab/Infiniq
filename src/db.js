import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(process.env.DB_FILE || path.join(config.dataDir, 'infiniq.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  phone TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  welcome_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  channel TEXT NOT NULL,
  destination TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  tags TEXT NOT NULL DEFAULT '',
  language TEXT,
  audio_file TEXT,
  mime TEXT,
  size_bytes INTEGER,
  duration_sec REAL,
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  transcript_source TEXT,
  segments_json TEXT NOT NULL DEFAULT '[]',
  speakers_json TEXT NOT NULL DEFAULT '{}',
  pitch_json TEXT,
  bookmarks_json TEXT NOT NULL DEFAULT '[]',
  notes_md TEXT NOT NULL DEFAULT '',
  ai_notes_md TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_user ON recordings(user_id, created_at DESC);
`);

export const now = () => Date.now();
export const newId = () => crypto.randomUUID();
