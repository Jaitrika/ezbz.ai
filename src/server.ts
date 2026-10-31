import 'dotenv/config';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { config } from './config.js';
import { db, enqueue, getConversation } from './db.js';
import { parseWhatsApp, verifyWhatsAppSignature } from './providers/whatsapp.js';
import { verifyBolna } from './providers/bolna.js';
import { handleTool, processBolnaWebhook, startWorker } from './application.js';

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
await app.register(rawBody, { field: 'rawBody', global: false, runFirst: true, encoding: false });
app.get('/health', async () => ({ ok: true, database: db.open, storage: config.dataDir }));
app.get('/webhooks/whatsapp', async (request, reply) => {
  const q = request.query as Record<string, string>;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.whatsappVerifyToken) return reply.type('text/plain').send(q['hub.challenge']);
  return reply.code(403).send('verification failed');
});
app.post('/webhooks/whatsapp', async (request: any, reply) => {
  const raw = request.rawBody as Buffer | undefined;
  if (!raw || !verifyWhatsAppSignature(raw, request.headers['x-hub-signature-256'])) return reply.code(401).send({ error: 'invalid signature' });
  const messages = parseWhatsApp(request.body);
  for (const message of messages) {
    if (!message.id || !message.text || (config.allowedBuyer && message.from !== config.allowedBuyer)) continue;
    const conversation = getConversation(message.from);
    const created = db.prepare(`INSERT OR IGNORE INTO messages(conversation_id,direction,provider_message_id,content) VALUES(?,'in',?,?)`)
      .run(conversation.id, message.id, message.text).changes;
    if (created) enqueue(`process-message:${message.id}`, 'process_message', { buyer: message.from, messageId: message.id, text: message.text });
  }
  return reply.code(200).send({ received: true });
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
