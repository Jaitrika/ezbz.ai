import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { createChat, db, enqueue, getChat, getChatOwner, listChats } from './db.js';
import { verifyBolna } from './providers/bolna.js';
import { handleTool, parseBuyerSellerContacts, processBolnaWebhook, startWorker } from './application.js';

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const demoBuyer = 'web-demo';

app.get('/', async (_request, reply) => {
  const html = await readFile(path.resolve('public/index.html'), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});
app.get('/health', async () => ({ ok: true, database: db.open }));
app.get<{ Querystring: { chatId?: string } }>('/api/state', async (request, reply) => {
  const owner = getChatOwner(demoBuyer);
  const conversation = owner.conversation;
  const thread = request.query.chatId ? getChat(demoBuyer, request.query.chatId) : owner.thread;
  if (!thread) return reply.code(404).send({ error: 'Chat not found' });
  const campaign = thread.active_campaign_id
    ? db.prepare('SELECT * FROM campaigns WHERE id=? AND thread_id=?').get(thread.active_campaign_id, thread.id) as any
    : null;
  const sellers = campaign ? db.prepare('SELECT * FROM sellers WHERE campaign_id=? ORDER BY position').all(campaign.id) as any[] : [];
  const calls = campaign ? db.prepare(`SELECT calls.*, sellers.business_name,sellers.phone_e164,sellers.product_url
    FROM calls JOIN sellers ON sellers.id=calls.seller_id WHERE calls.campaign_id=? ORDER BY calls.rowid`).all(campaign.id) as any[] : [];
  const messages = db.prepare('SELECT direction,content,created_at FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 80')
    .all(thread.id).reverse();
  return {
    chatId: thread.id,
    campaign: campaign ? { ...campaign, brief: campaign.brief_json ? JSON.parse(campaign.brief_json) : null, result: campaign.result_json ? JSON.parse(campaign.result_json) : null } : null,
    sellers, calls: calls.map(c => ({ ...c, quote: c.quote_json ? JSON.parse(c.quote_json) : null })), messages,
  };
});
app.get('/api/chats', async () => {
  const owner = getChatOwner(demoBuyer);
  return { chats: listChats(demoBuyer), defaultChatId: owner.thread.id };
});
app.post('/api/chats', async () => {
  const chat = createChat(demoBuyer);
  return { chatId: chat.id, title: chat.title };
});
app.post<{ Body: { text?: string; sellerContacts?: string; chatId?: string } }>('/api/messages', async (request, reply) => {
  const text = String(request.body?.text ?? '').trim();
  if (!text) return reply.code(400).send({ error: 'Enter a product link or message' });
  if (text.length > 4000) return reply.code(413).send({ error: 'Message is too long' });
  const parsedContacts = parseBuyerSellerContacts(String(request.body?.sellerContacts ?? ''));
  if (parsedContacts.error) return reply.code(400).send({ error: parsedContacts.error });
  const owner = getChatOwner(demoBuyer);
  const thread = request.body?.chatId ? getChat(demoBuyer, request.body.chatId) : owner.thread;
  if (!thread) return reply.code(404).send({ error: 'Chat not found' });
  const messageId = randomUUID();
  enqueue(`process-message:${messageId}`, 'process_message', { buyer: demoBuyer, threadId: thread.id, messageId, text, sellerContacts: parsedContacts.sellers ?? [] });
  return reply.code(202).send({ accepted: true, messageId });
});
app.get<{ Params: { callId: string } }>('/api/recordings/:callId', async (request, reply) => {
  const call = db.prepare('SELECT recording_path FROM calls WHERE id=?').get(request.params.callId) as any;
  if (!call?.recording_path) return reply.code(404).send({ error: 'Recording not ready' });
  const recordingsRoot = path.resolve(config.dataDir, 'recordings') + path.sep;
  const recordingPath = path.resolve(call.recording_path);
  if (!recordingPath.startsWith(recordingsRoot)) return reply.code(403).send({ error: 'Invalid recording path' });
  const ext = path.extname(recordingPath).toLowerCase();
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : 'application/octet-stream';
  return reply.type(mime).header('cache-control', 'no-store').send(createReadStream(recordingPath));
});

app.post('/webhooks/bolna', async (request: any, reply) => {
  if (!verifyBolna({ headers: request.headers, body: request.body })) return reply.code(401).send({ error: 'invalid signature' });
  await processBolnaWebhook(request.body); return { received: true };
});
app.post<{ Params: { name: string } }>('/bolna/tools/:name', async (request: any, reply) => {
  const supplied = String(request.headers['x-tool-secret'] ?? request.body?.tool_secret ?? '');
  if (!config.bolnaToolSecret || supplied !== config.bolnaToolSecret) return reply.code(401).send({ error: 'unauthorized' });
  try { return await handleTool(request.params.name, request.body); }
  catch (error) { return reply.code(400).send({ error: String(error) }); }
});
app.setErrorHandler((error, _request, reply) => { app.log.error(error); reply.code(500).send({ error: 'internal error' }); });
startWorker();
await app.listen({ port: config.port, host: '0.0.0.0' });
const shutdown = async () => { await app.close(); db.close(); process.exit(0); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
