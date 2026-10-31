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
CREATE TABLE IF NOT EXISTS chat_threads (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 title TEXT NOT NULL DEFAULT 'New chat', active_campaign_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('messages', 'thread_id', 'TEXT REFERENCES chat_threads(id)');
ensureColumn('campaigns', 'thread_id', 'TEXT REFERENCES chat_threads(id)');

// Keep existing demo data together as the first chat when upgrading an older database.
const seedThreads = db.prepare(`INSERT INTO chat_threads(id,conversation_id,title,active_campaign_id)
 SELECT lower(hex(randomblob(16))), c.id, 'Previous chat', c.active_campaign_id
 FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM chat_threads t WHERE t.conversation_id=c.id)`);
seedThreads.run();
db.exec(`UPDATE campaigns SET thread_id=(SELECT t.id FROM chat_threads t WHERE t.conversation_id=campaigns.conversation_id ORDER BY t.created_at LIMIT 1) WHERE thread_id IS NULL;
UPDATE messages SET thread_id=(SELECT t.id FROM chat_threads t WHERE t.conversation_id=messages.conversation_id ORDER BY t.created_at LIMIT 1) WHERE thread_id IS NULL;
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS campaigns_thread ON campaigns(thread_id, created_at);`);

export const id = () => crypto.randomUUID();
export function enqueue(uniqueKey: string, kind: string, payload: unknown) {
  db.prepare(`INSERT OR IGNORE INTO jobs(unique_key,kind,payload) VALUES(?,?,?)`)
    .run(uniqueKey, kind, JSON.stringify(payload));
}
export function logMessage(conversationId: string, direction: 'in' | 'out', content: string, providerId?: string, threadId?: string) {
  db.prepare(`INSERT OR IGNORE INTO messages(conversation_id,direction,provider_message_id,content,thread_id) VALUES(?,?,?,?,?)`)
    .run(conversationId, direction, providerId ?? null, content, threadId ?? null);
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

export function getChatOwner(buyer: string) {
  const conversation = getConversation(buyer);
  let thread = db.prepare('SELECT * FROM chat_threads WHERE conversation_id=? ORDER BY created_at LIMIT 1').get(conversation.id) as any;
  if (!thread) {
    const threadId = id();
    db.prepare('INSERT INTO chat_threads(id,conversation_id,title,active_campaign_id) VALUES(?,?,?,?)')
      .run(threadId, conversation.id, 'New chat', conversation.active_campaign_id);
    thread = db.prepare('SELECT * FROM chat_threads WHERE id=?').get(threadId);
  }
  return { conversation, thread };
}

export function createChat(buyer: string) {
  const conversation = getConversation(buyer);
  const threadId = id();
  db.prepare('INSERT INTO chat_threads(id,conversation_id,title) VALUES(?,?,?)').run(threadId, conversation.id, 'New chat');
  return db.prepare('SELECT * FROM chat_threads WHERE id=?').get(threadId) as any;
}

export function getChat(buyer: string, threadId: string) {
  const conversation = getConversation(buyer);
  return db.prepare('SELECT * FROM chat_threads WHERE id=? AND conversation_id=?').get(threadId, conversation.id) as any;
}

export function listChats(buyer: string) {
  const conversation = getConversation(buyer);
  return db.prepare(`SELECT t.id,t.title,t.created_at,t.updated_at,
    (SELECT request_text FROM campaigns c WHERE c.thread_id=t.id ORDER BY c.created_at LIMIT 1) AS product,
    (SELECT content FROM messages m WHERE m.thread_id=t.id AND m.direction='in' ORDER BY m.id LIMIT 1) AS first_message
    FROM chat_threads t WHERE t.conversation_id=? ORDER BY t.updated_at DESC,t.created_at DESC`).all(conversation.id) as any[];
}

export const newId = id;
