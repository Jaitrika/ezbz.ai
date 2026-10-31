import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';

export const db = new Database(path.join(config.dataDir, 'sauda.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, buyer_wa_id TEXT UNIQUE NOT NULL, active_campaign_id TEXT,
 last_inbound_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 direction TEXT NOT NULL, provider_message_id TEXT UNIQUE, content TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS campaigns (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 state TEXT NOT NULL, request_text TEXT NOT NULL, brief_json TEXT, result_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sellers (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), position INTEGER NOT NULL,
 business_name TEXT NOT NULL, phone_e164 TEXT, product_url TEXT, source_url TEXT,
 evidence TEXT, match_state TEXT NOT NULL DEFAULT 'unverified', excluded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calls (
 id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), seller_id TEXT NOT NULL REFERENCES sellers(id),
 round INTEGER NOT NULL, state TEXT NOT NULL, bolna_execution_id TEXT UNIQUE, transcript TEXT,
 recording_url TEXT, recording_path TEXT, quote_json TEXT, started_at TEXT, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, unique_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 due_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_error TEXT
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_key TEXT UNIQUE,
 campaign_id TEXT, call_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, due_at);
CREATE INDEX IF NOT EXISTS calls_campaign ON calls(campaign_id, round);
`);

export const id = () => crypto.randomUUID();
export function enqueue(uniqueKey: string, kind: string, payload: unknown) {
  db.prepare(`INSERT OR IGNORE INTO jobs(unique_key,kind,payload) VALUES(?,?,?)`)
    .run(uniqueKey, kind, JSON.stringify(payload));
}
export function logMessage(conversationId: string, direction: 'in' | 'out', content: string, providerId?: string) {
  db.prepare(`INSERT OR IGNORE INTO messages(conversation_id,direction,provider_message_id,content) VALUES(?,?,?,?)`)
    .run(conversationId, direction, providerId ?? null, content);
}
export function getConversation(buyer: string) {
  let row = db.prepare('SELECT * FROM conversations WHERE buyer_wa_id=?').get(buyer) as any;
  if (!row) {
    const conversationId = id();
    db.prepare('INSERT INTO conversations(id,buyer_wa_id) VALUES(?,?)').run(conversationId, buyer);
    row = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
  }
  return row as { id: string; buyer_wa_id: string; active_campaign_id: string | null };
}

export const newId = id;
