import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { createChat, db, enqueue, getChat, getChatOwner, listChats } from './db.js';
import { verifyBolna } from './providers/bolna.js';
import { handleTool, parseBuyerSellerContacts, processBolnaWebhook, queueIndividualSellerCall, startWorker } from './application.js';
import { backfillSellerDatabase } from './seller-memory.js';

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  const source = String(body);
  if (!source.trim()) { done(null, {}); return; }
  try { done(null, JSON.parse(source)); }
  catch (error) { done(error as Error); }
});
const demoBuyer = 'web-demo';

app.get('/', async (_request, reply) => {
  const built = path.resolve('web/dist/index.html');
  const html = await readFile(built, 'utf8').catch(() => readFile(path.resolve('public/index.html'), 'utf8'));
  return reply.type('text/html; charset=utf-8').send(html);
});
app.get<{ Params: { file: string } }>('/assets/:file', async (request, reply) => {
  const file = path.basename(request.params.file);
  const assetPath = path.resolve('web/dist/assets', file);
  try {
    const body = await readFile(assetPath);
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    return reply.type(type).header('cache-control', 'public, max-age=3600').send(body);
  } catch {
    return reply.code(404).send({ error: 'asset not found' });
  }
});
app.get('/health', async () => ({ ok: true, database: db.open }));
app.get<{ Querystring: { chatId?: string } }>('/api/state', async (request, reply) => {
  const owner = getChatOwner(demoBuyer);
  const conversation = owner.conversation;
  const thread = request.query.chatId ? getChat(demoBuyer, request.query.chatId) : owner.thread;
  if (!thread || thread.deleted_at) return reply.code(404).send({ error: 'Chat not found' });
  const campaign = thread.active_campaign_id
    ? db.prepare('SELECT * FROM campaigns WHERE id=? AND thread_id=?').get(thread.active_campaign_id, thread.id) as any
    : null;
  const campaignSellers = campaign ? db.prepare('SELECT * FROM sellers WHERE campaign_id=? ORDER BY position').all(campaign.id) as any[] : [];
  const sellers = campaignSellers.map(seller => {
    if (!seller.seller_product_id) return seller;
    const product = db.prepare(`SELECT product_name,latest_quote_json,latest_price,latest_price_basis,latest_quoted_at
      FROM seller_products WHERE id=?`).get(seller.seller_product_id) as any;
    const quote_history = db.prepare(`SELECT h.round,h.price,h.price_basis,h.previous_price,h.quoted_at,h.quote_json
      FROM seller_quote_history h JOIN calls c ON c.id=h.call_id
      WHERE h.seller_product_id=? ORDER BY COALESCE(c.completed_at,h.quoted_at) DESC,c.rowid DESC LIMIT 10`).all(seller.seller_product_id) as any[];
    return {
      ...seller,
      catalog_product_name: product?.product_name ?? null,
      latest_quote: product?.latest_quote_json ? JSON.parse(product.latest_quote_json) : null,
      latest_price: product?.latest_price ?? null,
      latest_price_basis: product?.latest_price_basis ?? null,
      latest_quoted_at: product?.latest_quoted_at ?? null,
      quote_history: quote_history.map(row => ({ ...row, quote: JSON.parse(row.quote_json) })),
    };
  });
  const calls = campaign ? db.prepare(`SELECT calls.*, sellers.business_name,sellers.phone_e164,sellers.product_url
    FROM calls JOIN sellers ON sellers.id=calls.seller_id
    WHERE calls.campaign_id=? ORDER BY calls.rowid`).all(campaign.id) as any[] : [];
  const messages = db.prepare('SELECT id,direction,content,created_at FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 80')
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
app.delete<{ Params: { chatId: string } }>('/api/chats/:chatId', async (request, reply) => {
  const thread = getChat(demoBuyer, request.params.chatId);
  if (!thread || thread.deleted_at) return reply.code(404).send({ error: 'Chat not found' });
  db.prepare(`UPDATE chat_threads SET deleted_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=? AND deleted_at IS NULL`)
    .run(thread.id);
  let chats = listChats(demoBuyer);
  if (!chats.length) {
    createChat(demoBuyer);
    chats = listChats(demoBuyer);
  }
  return { deleted: true, chats, defaultChatId: chats[0]?.id };
});
app.post<{ Params: { chatId: string; sellerId: string } }>('/api/chats/:chatId/sellers/:sellerId/call', async (request, reply) => {
  const thread = getChat(demoBuyer, request.params.chatId);
  if (!thread || thread.deleted_at) return reply.code(404).send({ error: 'Chat not found' });
  try {
    return { accepted: true, ...queueIndividualSellerCall(thread.id, request.params.sellerId) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post<{ Body: { text?: string; sellerContacts?: string; chatId?: string } }>('/api/messages', async (request, reply) => {
  const text = String(request.body?.text ?? '').trim();
  if (!text) return reply.code(400).send({ error: 'Enter a product link or message' });
  if (text.length > 4000) return reply.code(413).send({ error: 'Message is too long' });
  const parsedContacts = parseBuyerSellerContacts(String(request.body?.sellerContacts ?? ''));
  if (parsedContacts.error) return reply.code(400).send({ error: parsedContacts.error });
  const owner = getChatOwner(demoBuyer);
  const thread = request.body?.chatId ? getChat(demoBuyer, request.body.chatId) : owner.thread;
  if (!thread || thread.deleted_at) return reply.code(404).send({ error: 'Chat not found' });
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
backfillSellerDatabase();
startWorker();
await app.listen({ port: config.port, host: '0.0.0.0' });
const shutdown = async () => { await app.close(); db.close(); process.exit(0); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
