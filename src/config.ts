import { mkdirSync } from 'node:fs';
import path from 'node:path';

const env = process.env;
export const config = {
  port: Number(env.PORT ?? 3000),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  openaiApiKey: env.OPENAI_API_KEY ?? '',
  openaiModel: env.OPENAI_MODEL ?? 'gpt-5.5',
  bolnaApiKey: env.BOLNA_API_KEY ?? '',
  bolnaAgentId: env.BOLNA_AGENT_ID ?? '',
  bolnaFromNumber: env.BOLNA_FROM_NUMBER ?? '',
  bolnaToolSecret: env.BOLNA_TOOL_SECRET ?? '',
  bolnaWebhookSecret: env.BOLNA_WEBHOOK_SECRET ?? '',
  whatsappToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
  whatsappPhoneId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  whatsappAppSecret: env.WHATSAPP_APP_SECRET ?? '',
  whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
  whatsappGraphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v23.0',
  allowedBuyer: (env.ALLOWED_BUYER_WA_ID ?? '').replace(/\D/g, ''),
  maxSellers: Math.min(5, Math.max(1, Number(env.MAX_SELLERS ?? 3))),
  maxConcurrentCalls: Math.max(1, Number(env.MAX_CONCURRENT_CALLS ?? 2)),
};
mkdirSync(path.join(config.dataDir, 'recordings'), { recursive: true });
mkdirSync(path.join(config.dataDir, 'research'), { recursive: true });
