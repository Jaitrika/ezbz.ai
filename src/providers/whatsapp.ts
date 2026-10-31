import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const graph = `https://graph.facebook.com/${config.whatsappGraphVersion}`;
export function verifyWhatsAppSignature(raw: Buffer, signature = '') {
  if (!config.whatsappAppSecret) return false;
  const expected = `sha256=${createHmac('sha256', config.whatsappAppSecret).update(raw).digest('hex')}`;
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function sendText(to: string, body: string) {
  if (!config.whatsappToken || !config.whatsappPhoneId) throw new Error('WhatsApp credentials are not configured');
  const res = await fetch(`${graph}/${config.whatsappPhoneId}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${config.whatsappToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: body.slice(0, 4000) } }),
  });
  const data: any = await res.json(); if (!res.ok) throw new Error(`WhatsApp send failed ${res.status}: ${JSON.stringify(data)}`);
  return data.messages?.[0]?.id as string | undefined;
}
export async function sendAudio(to: string, filePath: string) {
  const file = await import('node:fs/promises').then(m => m.readFile(filePath));
  const ext = filePath.toLowerCase().split('.').pop();
  const audioTypes: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };
  const mime = audioTypes[ext ?? ''];
  if (!mime) throw new Error(`Recording format .${ext ?? '?'} cannot be sent as WhatsApp audio; check Bolna's recording format`);
  const form = new FormData(); form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([file], { type: mime }), `recording.${ext}`);
  const upload = await fetch(`${graph}/${config.whatsappPhoneId}/media`, { method: 'POST', headers: { authorization: `Bearer ${config.whatsappToken}` }, body: form });
  const media: any = await upload.json(); if (!upload.ok) throw new Error(`WhatsApp media upload failed: ${JSON.stringify(media)}`);
  const sent = await fetch(`${graph}/${config.whatsappPhoneId}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${config.whatsappToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'audio', audio: { id: media.id } }),
  });
  const result: any = await sent.json(); if (!sent.ok) throw new Error(`WhatsApp audio send failed: ${JSON.stringify(result)}`);
  return result.messages?.[0]?.id as string | undefined;
}
export function parseWhatsApp(body: any) {
  const changes = body?.entry?.flatMap((entry: any) => entry.changes ?? []) ?? [];
  return changes.flatMap((change: any) => change.value?.messages ?? []).map((message: any) => ({
    id: String(message.id ?? ''), from: String(message.from ?? '').replace(/\D/g, ''),
    text: message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? '',
    type: message.type,
  }));
}
