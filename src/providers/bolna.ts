import { config } from '../config.js';

async function api(path: string, init: RequestInit = {}) {
  if (!config.bolnaApiKey) throw new Error('BOLNA_API_KEY is not configured');
  const res = await fetch(`https://api.bolna.ai${path}`, {
    ...init, headers: { authorization: `Bearer ${config.bolnaApiKey}`, 'content-type': 'application/json', ...init.headers },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bolna ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
export async function startCall(phone: string, context: unknown) {
  if (!config.bolnaAgentId) throw new Error('BOLNA_AGENT_ID is not configured');
  return api('/call', { method: 'POST', body: JSON.stringify({
    agent_id: config.bolnaAgentId, recipient_phone_number: phone,
    ...(config.bolnaFromNumber ? { from_phone_number: config.bolnaFromNumber } : {}), user_data: context,
  }) });
}
export async function getExecution(executionId: string) { return api(`/executions/${encodeURIComponent(executionId)}`); }
export function verifyBolna(req: { headers: Record<string, any>; body: any }) {
  if (!config.bolnaWebhookSecret) return true;
  const supplied = String(req.headers['x-bolna-secret'] ?? req.body?.secret ?? '');
  return supplied === config.bolnaWebhookSecret;
}
