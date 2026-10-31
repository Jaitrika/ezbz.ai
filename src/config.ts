import { mkdirSync } from 'node:fs';
import path from 'node:path';

const env = process.env;
export const config = {
  port: Number(env.PORT ?? 3000),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  openaiApiKey: env.BOLNA_OPEN_AI_HACK_KEY ?? env.OPENAI_API_KEY ?? '',
  openaiModel: env.OPENAI_MODEL ?? 'gpt-6-luna',
  bolnaApiKey: env.BOLNA_API_KEY ?? '',
  bolnaAgentId: env.BOLNA_AGENT_ID ?? '',
  bolnaFromNumber: env.BOLNA_FROM_NUMBER ?? '',
  bolnaToolSecret: env.BOLNA_TOOL_SECRET ?? '',
  bolnaWebhookSecret: env.BOLNA_WEBHOOK_SECRET ?? '',
  maxSellers: Math.min(10, Math.max(1, Number(env.MAX_SELLERS ?? 10))),
  maxConcurrentCalls: Math.max(1, Number(env.MAX_CONCURRENT_CALLS ?? 2)),
};
mkdirSync(path.join(config.dataDir, 'recordings'), { recursive: true });
mkdirSync(path.join(config.dataDir, 'research'), { recursive: true });
