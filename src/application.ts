import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import { db, enqueue, getConversation, logMessage, newId } from './db.js';
import { researchProduct, extractQuote } from './providers/openai.js';
import { sendText, sendAudio } from './providers/whatsapp.js';
import { getExecution, startCall } from './providers/bolna.js';

type Job = { id: number; unique_key: string; kind: string; payload: string; attempts: number };
const say = async (conversationId: string, to: string, text: string) => {
  const messageId = await sendText(to, text);
  logMessage(conversationId, 'out', text, messageId);
};
const campaignFor = (id: string) => db.prepare('SELECT * FROM campaigns WHERE id=?').get(id) as any;
const sellersFor = (id: string) => db.prepare('SELECT * FROM sellers WHERE campaign_id=? AND excluded=0 ORDER BY position').all(id) as any[];
const callsFor = (id: string, round?: number) => db.prepare(`SELECT calls.*, sellers.business_name, sellers.phone_e164, sellers.product_url
 FROM calls JOIN sellers ON sellers.id=calls.seller_id WHERE calls.campaign_id=? ${round ? 'AND calls.round=?' : ''} ORDER BY calls.rowid`)
  .all(...(round ? [id, round] : [id])) as any[];

export async function processBuyerMessage(buyer: string, text: string, messageId: string) {
  const conversation = getConversation(buyer);
  const lower = text.trim().toLowerCase();
  logMessage(conversation.id, 'in', text, messageId);
  db.prepare('UPDATE conversations SET last_inbound_at=CURRENT_TIMESTAMP WHERE id=?').run(conversation.id);
  const campaignId = conversation.active_campaign_id;
  if (/^(stop|pause|cancel)\b/.test(lower)) {
    if (campaignId) {
      db.prepare("UPDATE campaigns SET state='paused',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
      db.prepare("UPDATE jobs SET state='cancelled' WHERE state='queued' AND payload LIKE ?").run(`%${campaignId}%`);
      await say(conversation.id, buyer, 'Paused. I will not start more calls. A seller already on a live call may still finish; send “resume” if you want to continue.');
    } else await say(conversation.id, buyer, 'There is no active request to pause.');
    return;
  }
  if (/^resume\b/.test(lower) && campaignId) {
    db.prepare("UPDATE campaigns SET state='collecting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='paused'").run(campaignId);
    enqueue(`advance:${campaignId}:resume`, 'advance_campaign', { campaignId });
    await say(conversation.id, buyer, 'Resumed. I will continue the remaining authorized work.'); return;
  }
  if (/^(status|progress)\b/.test(lower) && campaignId) {
    const campaign = campaignFor(campaignId); const calls = callsFor(campaignId);
    await say(conversation.id, buyer, `Request status: ${campaign.state}. Calls: ${calls.filter(c => c.state === 'completed').length} complete, ${calls.filter(c => ['queued','calling','in_progress'].includes(c.state)).length} in progress, ${calls.filter(c => ['failed','dispatch_unknown'].includes(c.state)).length} failed or needing dispatch review.`); return;
  }
  if (/^(compare|offers|quotes)\b/.test(lower) && campaignId) {
    const result = campaignFor(campaignId)?.result_json;
    if (!result) { await say(conversation.id, buyer, 'There are no completed comparable offers yet. Send “status” for progress.'); return; }
    const offers = JSON.parse(result).offers as any[];
    await say(conversation.id, buyer, offers.length ? offers.map((o, i) => `${i + 1}. ${o.seller}: ₹${o.quote.total} (round ${o.round})${o.quote.gst != null ? `; GST ${o.quote.gst}` : ''}${o.quote.shipping != null ? `; shipping ${o.quote.shipping}` : ''}`).join('\n') : 'No complete confirmed totals are available.'); return;
  }
  if (/^(transcript|transcripts)\b/.test(lower) && campaignId) {
    const calls = callsFor(campaignId).filter(c => c.transcript);
    if (!calls.length) { await say(conversation.id, buyer, 'No call transcript is available yet.'); return; }
    const selected = calls.find(c => lower.includes(c.business_name.toLowerCase())) ?? calls[calls.length - 1];
    await say(conversation.id, buyer, `Transcript — ${selected.business_name}:\n${String(selected.transcript).slice(0, 3500)}`); return;
  }
  if (/^exclude seller\b/.test(lower) && campaignId) {
    const name = text.replace(/^exclude seller\s*/i, '').trim().toLowerCase();
    const seller = sellersFor(campaignId).find(s => s.business_name.toLowerCase().includes(name));
    if (!seller) { await say(conversation.id, buyer, 'I could not match that seller. Reply “exclude seller” followed by the business name shown in the shortlist.'); return; }
    if (campaignFor(campaignId).state !== 'shortlist_ready') { await say(conversation.id, buyer, 'Seller exclusion is available before calls start. Send “stop” to pause an active campaign.'); return; }
    db.prepare('UPDATE sellers SET excluded=1 WHERE id=?').run(seller.id);
    await say(conversation.id, buyer, `Excluded ${seller.business_name}. The remaining displayed sellers are unchanged; reply “Call them all” when ready.`); return;
  }
  const correction = text.match(/^correct\s+(.+?)\s+(?:to\s+)?(?:₹|rs\.?\s*)\s*([\d,]+(?:\.\d{1,2})?)\s*$/i);
  if (correction && campaignId) {
    const sellerName = correction[1].trim().toLowerCase(); const amount = Number(correction[2].replace(/,/g, ''));
    const call = callsFor(campaignId).find(c => c.business_name.toLowerCase().includes(sellerName) && c.quote_json);
    if (!call || !Number.isFinite(amount)) { await say(conversation.id, buyer, 'I could not find an extracted quote for that seller. Use: “correct [seller name] to ₹[total]”.'); return; }
    const quote = JSON.parse(call.quote_json); quote.total = amount; quote.corrected_by_buyer = true;
    db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(quote), call.id);
    const offers = callsFor(campaignId).filter(c => c.quote_json).map(c => ({ seller: c.business_name, total: JSON.parse(c.quote_json).total })).filter(o => typeof o.total === 'number').sort((a,b) => a.total - b.total);
    const result = { offers: offers.map(o => ({ ...o, quote: { total: o.total } })), best: offers[0] ?? null };
    db.prepare('UPDATE campaigns SET result_json=? WHERE id=?').run(JSON.stringify(result), campaignId);
    await say(conversation.id, buyer, `Updated ${call.business_name}'s total to ₹${amount}. The comparison has been recalculated.`); return;
  }
  if (/\b(call them all|call all|start calls|go ahead|yes,? call)\b/.test(lower)) {
    if (!campaignId) { await say(conversation.id, buyer, 'Send a product link or description first, and I will research sellers.'); return; }
    const campaign = campaignFor(campaignId);
    if (campaign.state === 'collecting') { await say(conversation.id, buyer, 'Calls were already authorized for this shortlist. Send “status” to check progress.'); return; }
    if (campaign.state !== 'shortlist_ready') { await say(conversation.id, buyer, `This request is ${campaign.state}. Send a new product link for another request.`); return; }
    const sellers = sellersFor(campaignId).filter(s => s.phone_e164 && s.match_state === 'verified');
    if (!sellers.length) { await say(conversation.id, buyer, 'I could not verify a callable seller phone number from the research. I will not dial an unverified number.'); return; }
    const authKey = `authorize:${campaignId}`;
    const tx = db.transaction(() => {
      db.prepare("UPDATE campaigns SET state='collecting',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
      for (const seller of sellers) {
        const callId = newId();
        db.prepare(`INSERT OR IGNORE INTO calls(id,campaign_id,seller_id,round,state) VALUES(?,?,?,1,'queued')`).run(callId, campaignId, seller.id);
        enqueue(`dispatch:${callId}`, 'dispatch_call', { callId });
      }
      db.prepare('INSERT OR IGNORE INTO events(source,event_key,campaign_id,type,payload) VALUES(?,?,?,?,?)')
        .run('buyer', authKey, campaignId, 'calls_authorized', JSON.stringify({ messageId, sellerIds: sellers.map(s => s.id) }));
    });
    tx();
    await say(conversation.id, buyer, `Authorized. I am calling ${sellers.length} researched sellers now. You can send “status”, “stop”, or “recording”.`); return;
  }
  if (/\b(recording|play audio|play call)\b/.test(lower) && campaignId) {
    const call = db.prepare("SELECT * FROM calls WHERE campaign_id=? AND recording_path IS NOT NULL ORDER BY completed_at DESC LIMIT 1").get(campaignId) as any;
    if (!call) { await say(conversation.id, buyer, 'No completed recording is available yet. Ask again after the call finishes.'); return; }
    enqueue(`audio:${call.id}`, 'send_recording', { callId: call.id, buyer, conversationId: conversation.id });
    await say(conversation.id, buyer, 'Sending the latest saved call recording.'); return;
  }
  if (campaignId && ['shortlist_ready','collecting','validating','renegotiating','result_ready'].includes(campaignFor(campaignId)?.state)) {
    await say(conversation.id, buyer, 'I have this request in progress. Send “status”, “call them all” (to authorize calls), “recording”, or “stop”. For a different product, send “new:” followed by its link or description.');
    if (!lower.startsWith('new:')) return;
    text = text.replace(/^new:\s*/i, '');
  }
  createCampaign(conversation.id, buyer, text);
}

function createCampaign(conversationId: string, buyer: string, request: string) {
  const campaignId = newId();
  db.prepare("INSERT INTO campaigns(id,conversation_id,state,request_text) VALUES(?,?,'researching',?)").run(campaignId, conversationId, request);
  db.prepare('UPDATE conversations SET active_campaign_id=? WHERE id=?').run(campaignId, conversationId);
  enqueue(`research:${campaignId}`, 'research', { campaignId, buyer, conversationId, request });
}

async function doResearch(p: any) {
  const result = await researchProduct(p.request, config.maxSellers);
  const campaign = campaignFor(p.campaignId);
  if (!campaign || campaign.state !== 'researching') return;
  const insert = db.prepare(`INSERT INTO sellers(id,campaign_id,position,business_name,phone_e164,product_url,source_url,evidence,match_state)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const add = db.transaction(() => {
    result.sellers.slice(0, config.maxSellers).forEach((seller, i) => {
      let phone: string | null = null; let verified = false;
      if (seller.phone) {
        const parsed = parsePhoneNumberFromString(seller.phone, 'IN');
        if (parsed?.isValid() && parsed.country === 'IN' && seller.evidence.toLowerCase().includes(seller.phone.replace(/\D/g, '').slice(-5))) {
          phone = parsed.number; verified = true;
        }
      }
      insert.run(newId(), p.campaignId, i + 1, seller.business_name, phone, seller.product_url,
        seller.source_url, seller.evidence, verified ? 'verified' : 'unverified');
    });
    db.prepare("UPDATE campaigns SET state='shortlist_ready',brief_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify({ product_summary: result.product_summary, product_attributes: result.product_attributes, missing_questions: result.missing_questions }), p.campaignId);
  });
  add();
  const sellers = sellersFor(p.campaignId);
  const list = sellers.map((s, i) => `${i + 1}. ${s.business_name}${s.match_state === 'verified' ? ` — ${s.phone_e164}` : ' — phone not verified; will not call'}\n   Product: ${s.product_url ?? 'not provided'}\n   Source: ${s.source_url}\n   Evidence: ${s.evidence}`).join('\n\n');
  const questions = result.missing_questions.length ? `\n\nNeed to know: ${result.missing_questions.join('; ')}` : '';
  await say(p.conversationId, p.buyer, `I researched your request.\n\nProduct: ${result.product_summary}\nDetails: ${result.product_attributes.join(', ') || 'not confirmed'}\n\nSellers:\n${list || 'No sellers with usable source evidence were found.'}${questions}\n\nReply “Call them all” to authorize calls to the sellers with verified phone numbers.`);
}

async function dispatchCall(p: any) {
  const call = db.prepare(`SELECT calls.*, sellers.business_name,sellers.phone_e164,sellers.product_url,sellers.evidence,
    campaigns.brief_json,campaigns.request_text,campaigns.state AS campaign_state FROM calls
    JOIN sellers ON sellers.id=calls.seller_id JOIN campaigns ON campaigns.id=calls.campaign_id WHERE calls.id=?`).get(p.callId) as any;
  if (!call || call.campaign_state !== 'collecting' || !call.phone_e164) return;
  db.prepare("UPDATE calls SET state='calling',started_at=CURRENT_TIMESTAMP WHERE id=?").run(call.id);
  try {
    const resp = await startCall(call.phone_e164, {
      app_call_id: call.id, campaign_id: call.campaign_id, seller_name: call.business_name,
      purchase_request: call.request_text, product_brief: call.brief_json,
      product_url: call.product_url, seller_evidence: call.evidence,
      round: call.round, benchmark: call.round === 2 ? call.quote_json : null,
      language_instruction: 'Speak naturally in Hindi or English. Detect the seller\'s language and respond in that language; switch when the seller switches.',
      negotiation_rules: 'Identify yourself as an AI calling for a buyer. Confirm exact item, variant, quantity and availability. Ask for item price, GST, shipping, delivery, validity and invoice terms separately. Never invent a competing quote or make a purchase commitment. Ask for their best genuine price; quote a competitor only when benchmark data is supplied. Ask permission for a follow-up. End politely.',
    });
    const executionId = String(resp.execution_id ?? resp.id ?? '');
    if (!executionId) throw new Error(`Bolna response lacked execution_id: ${JSON.stringify(resp)}`);
    db.prepare('UPDATE calls SET bolna_execution_id=? WHERE id=?').run(executionId, call.id);
  } catch (error) {
    // A timeout can happen after Bolna accepted the request. Never auto-redial an ambiguous dispatch.
    const definitiveRejection = /^Bolna 4\d\d:/.test(String(error));
    db.prepare('UPDATE calls SET state=? WHERE id=?').run(definitiveRejection ? 'failed' : 'dispatch_unknown', call.id);
    logEvent('app', `call-dispatch-error:${call.id}`, call.campaign_id, call.id,
      definitiveRejection ? 'call_failed' : 'call_dispatch_unknown', { error: String(error) });
    enqueue(`advance:${call.campaign_id}:dispatch-error:${call.round}`, 'advance_campaign', { campaignId: call.campaign_id });
  }
}

function logEvent(source: string, key: string, campaignId: string | null, callId: string | null, type: string, payload: unknown) {
  db.prepare('INSERT OR IGNORE INTO events(source,event_key,campaign_id,call_id,type,payload) VALUES(?,?,?,?,?,?)')
    .run(source, key, campaignId, callId, type, JSON.stringify(payload));
}

export async function processBolnaWebhook(body: any) {
  const executionId = String(body.execution_id ?? body.data?.execution_id ?? body.call_id ?? '');
  if (!executionId) { logEvent('bolna', null as any, null, null, 'unmatched_webhook', body); return; }
  let call = db.prepare('SELECT * FROM calls WHERE bolna_execution_id=?').get(executionId) as any;
  if (!call) {
    const appCallId = String(body.user_data?.app_call_id ?? body.data?.user_data?.app_call_id ?? '');
    if (appCallId) {
      db.prepare('UPDATE calls SET bolna_execution_id=? WHERE id=? AND bolna_execution_id IS NULL').run(executionId, appCallId);
      call = db.prepare('SELECT * FROM calls WHERE id=?').get(appCallId) as any;
    }
  }
  const eventName = String(body.status ?? body.event ?? body.data?.status ?? body.data?.event ?? 'updated').toLowerCase();
  logEvent('bolna', `webhook:${executionId}:${eventName}:${body.timestamp ?? ''}`, call?.campaign_id ?? null, call?.id ?? null, eventName, body);
  if (!call) return;
  const terminal = ['completed','failed','busy','no-answer','no_answer','cancelled'];
  const state = eventName.includes('complete') ? 'completed' : eventName.includes('progress') || eventName.includes('connect') ? 'in_progress'
    : eventName.includes('busy') ? 'busy' : eventName.includes('no-answer') || eventName.includes('no_answer') ? 'no_answer'
    : eventName.includes('fail') ? 'failed' : undefined;
  if (state) {
    db.prepare(`UPDATE calls SET state=?,completed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id=? AND state NOT IN ('completed','failed','busy','no_answer')`)
      .run(state, terminal.includes(state) ? 1 : 0, call.id);
  }
  const transcript = body.transcript ?? body.data?.transcript ?? body.execution?.transcript ?? body.data?.execution?.transcript;
  const recordingUrl = body.recording_url ?? body.data?.recording_url ?? body.execution?.recording_url ?? body.data?.execution?.recording_url;
  if (transcript || recordingUrl) db.prepare('UPDATE calls SET transcript=COALESCE(?,transcript),recording_url=COALESCE(?,recording_url) WHERE id=?')
    .run(transcript ? String(transcript) : null, recordingUrl ? String(recordingUrl) : null, call.id);
  if (state === 'completed' || eventName.includes('disconnect')) enqueue(`reconcile:${call.id}`, 'reconcile_call', { callId: call.id });
  else if (state && terminal.includes(state)) enqueue(`advance:${call.campaign_id}:${call.round}`, 'advance_campaign', { campaignId: call.campaign_id });
}

async function doReconcile(p: any) {
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(p.callId) as any;
  if (!call) return;
  let payload: any = {};
  if (call.bolna_execution_id) {
    try { payload = await getExecution(call.bolna_execution_id); } catch { /* webhook artifacts may already be complete */ }
  }
  const data = payload.execution ?? payload.data ?? payload;
  const transcript = call.transcript ?? data.transcript ?? data.transcription ?? '';
  const recordingUrl = call.recording_url ?? data.recording_url ?? data.recording ?? data.audio_url;
  db.prepare('UPDATE calls SET transcript=?,recording_url=? WHERE id=?').run(String(transcript), recordingUrl ? String(recordingUrl) : null, call.id);
  const campaign = campaignFor(call.campaign_id);
  if (transcript) {
    try {
      const quoteText = await extractQuote(String(transcript), campaign.brief_json ?? campaign.request_text);
      let quote: any; try { quote = JSON.parse(quoteText); } catch { quote = { raw: quoteText }; }
      db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(quote), call.id);
    } catch (e) { db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify({ extraction_error: String(e) }), call.id); }
  }
  if (recordingUrl && !call.recording_path) {
    try {
      const res = await fetch(recordingUrl); if (!res.ok || !res.body) throw new Error(`Recording download HTTP ${res.status}`);
      const dir = path.join(config.dataDir, 'recordings', call.id); await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, 'source.tmp'); const ext = (res.headers.get('content-type') ?? '').includes('mpeg') ? '.mp3' : (res.headers.get('content-type') ?? '').includes('wav') ? '.wav' : '.audio'; const final = path.join(dir, `source${ext}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp)); await rename(tmp, final);
      db.prepare('UPDATE calls SET recording_path=? WHERE id=?').run(final, call.id);
    } catch (e) { logEvent('app', `recording-failed:${call.id}`, call.campaign_id, call.id, 'recording_download_failed', { error: String(e) }); }
  }
  if ((!transcript || !recordingUrl) && (p.retry ?? 0) < 4) {
    const retry = (p.retry ?? 0) + 1;
    db.prepare(`INSERT OR IGNORE INTO jobs(unique_key,kind,payload,due_at) VALUES(?,?,?,datetime('now',?))`)
      .run(`reconcile:${call.id}:retry:${retry}`, 'reconcile_call', JSON.stringify({ callId: call.id, retry }), `+${retry * 15} seconds`);
    return;
  }
  enqueue(`advance:${call.campaign_id}:${call.round}`, 'advance_campaign', { campaignId: call.campaign_id });
}

async function advanceCampaign(p: any) {
  const campaign = campaignFor(p.campaignId); if (!campaign || ['paused','result_ready'].includes(campaign.state)) return;
  const first = callsFor(p.campaignId, 1);
  if (first.some(c => !['completed','failed','busy','no_answer','cancelled','dispatch_unknown'].includes(c.state))) return;
  const second = callsFor(p.campaignId, 2);
  if (!second.length) {
    const quoted = first.filter(c => c.quote_json && !JSON.parse(c.quote_json).extraction_error);
    const normalized = quoted.map(c => ({ call: c, quote: JSON.parse(c.quote_json) })).filter(x => typeof x.quote.total === 'number');
    const sorted = normalized.slice().sort((a, b) => a.quote.total - b.quote.total);
    if (sorted.length > 1) {
      const bestTotal = sorted[0].quote.total;
      const followups = sorted.filter(x => x.quote.total > bestTotal && x.quote.callback_permission === true);
      for (const item of followups) {
        const newCallId = newId();
        db.prepare("INSERT INTO calls(id,campaign_id,seller_id,round,state,quote_json) VALUES(?,?,?,2,'queued',?)")
          .run(newCallId, p.campaignId, item.call.seller_id, JSON.stringify({ benchmark: bestTotal, competitor: sorted[0].call.business_name }));
        enqueue(`dispatch:${newCallId}`, 'dispatch_call', { callId: newCallId });
      }
      if (followups.length) {
        db.prepare("UPDATE campaigns SET state='renegotiating',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
        await notifyCampaign(p.campaignId, `First calls are complete. I found a comparable quote at ₹${bestTotal}; I am calling ${followups.length} seller(s) back with that verified benchmark.`); return;
      }
    }
    db.prepare("UPDATE campaigns SET state='validating',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
  } else if (second.some(c => !['completed','failed','busy','no_answer','cancelled','dispatch_unknown'].includes(c.state))) return;
  const all = callsFor(p.campaignId);
  const offers = all.filter(c => c.quote_json).map(c => ({ seller: c.business_name, phone: c.phone_e164, url: c.product_url, round: c.round, quote: JSON.parse(c.quote_json) }))
    .filter(x => typeof x.quote.total === 'number').sort((a, b) => a.quote.total - b.quote.total);
  const result = { offers, best: offers[0] ?? null };
  db.prepare("UPDATE campaigns SET state='result_ready',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(result), p.campaignId);
  const body = offers.length ? `Negotiations are complete.\n\nBest confirmed quote: ${offers[0].seller} (${offers[0].phone})\nTotal quoted: ₹${offers[0].quote.total}${offers[0].quote.delivery ? `\nDelivery: ${offers[0].quote.delivery}` : ''}${offers[0].quote.validity ? `\nValid until: ${offers[0].quote.validity}` : ''}\nProduct: ${offers[0].url ?? 'see researched link'}\n\nOther confirmed offers: ${offers.slice(1).map(o => `${o.seller}: ₹${o.quote.total}`).join('; ') || 'none'}\n\nSend “recording” to hear the latest saved call. Quotes are seller statements; confirm details with the seller before payment.`
    : 'Calls are complete, but I could not verify a complete comparable total from the transcripts. No price is being presented as a confirmed best quote. Send “recording” to hear the latest saved call.';
  await notifyCampaign(p.campaignId, body);
}

async function notifyCampaign(campaignId: string, text: string) {
  const campaign = campaignFor(campaignId); const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(campaign.conversation_id) as any;
  await say(conversation.id, conversation.buyer_wa_id, text);
}

async function doSendRecording(p: any) {
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(p.callId) as any;
  if (!call?.recording_path) { await say(p.conversationId, p.buyer, 'The recording file is not available yet.'); return; }
  const messageId = await sendAudio(p.buyer, call.recording_path);
  logMessage(p.conversationId, 'out', `Recording for call ${call.id}`, messageId);
}

export async function handleTool(name: string, body: any) {
  const callId = String(body.app_call_id ?? body.user_data?.app_call_id ?? body.context?.app_call_id ?? '');
  const call = db.prepare(`SELECT calls.*, sellers.business_name,sellers.phone_e164,campaigns.brief_json,campaigns.request_text,campaigns.state campaign_state
    FROM calls JOIN sellers ON sellers.id=calls.seller_id JOIN campaigns ON campaigns.id=calls.campaign_id WHERE calls.id=?`).get(callId) as any;
  if (!call) throw new Error('Unknown call context');
  if (name === 'get_negotiation_brief') return { seller: call.business_name, product: call.brief_json ?? call.request_text, round: call.round, quote_context: call.quote_json, stop: call.campaign_state === 'paused' };
  if (name === 'capture_quote') { db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(body.quote ?? body), call.id); return { saved: true }; }
  if (name === 'next_negotiation_move') return { instruction: call.round === 2 ? 'Ask whether they can meet or improve on the buyer-provided verified benchmark; do not state the competitor identity unless the buyer context explicitly permits it.' : 'Ask for their best total price including GST and shipping, and confirm delivery and validity.' };
  if (name === 'record_followup') {
    const prior = call.quote_json ? JSON.parse(call.quote_json) : {};
    prior.callback_permission = body.callback_permission === true;
    if (body.callback_time) prior.callback_time = body.callback_time;
    db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(prior), call.id); return { saved: true };
  }
  throw new Error('Unknown tool');
}

const runners: Record<string, (payload: any) => Promise<void>> = {
  research: doResearch, dispatch_call: dispatchCall, reconcile_call: doReconcile,
  advance_campaign: advanceCampaign, send_recording: doSendRecording,
  process_message: async p => processBuyerMessage(p.buyer, p.text, p.messageId),
};
const activeJobs = new Set<number>();
export function startWorker() {
  setInterval(async () => {
    if (activeJobs.size >= 3) return;
    const job = db.prepare(`SELECT * FROM jobs WHERE state='queued' AND due_at<=CURRENT_TIMESTAMP ORDER BY id LIMIT 1`).get() as Job | undefined;
    if (!job) return;
    const claimed = db.prepare("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=? AND state='queued'").run(job.id).changes;
    if (!claimed) return;
    activeJobs.add(job.id);
    void (async () => {
      try {
        const handler = runners[job.kind]; if (!handler) throw new Error(`Unknown job: ${job.kind}`);
        await handler(JSON.parse(job.payload)); db.prepare("UPDATE jobs SET state='done',last_error=NULL WHERE id=?").run(job.id);
      } catch (error) {
        const attempts = job.attempts + 1; const terminal = attempts >= 3;
        db.prepare(`UPDATE jobs SET state=?,due_at=datetime('now',?),last_error=? WHERE id=?`)
          .run(terminal ? 'failed' : 'queued', `+${Math.min(60, 2 ** attempts)} seconds`, String(error), job.id);
        console.error(`job ${job.id} ${job.kind} failed`, error);
      } finally { activeJobs.delete(job.id); }
    })();
  }, 750).unref();
  db.prepare("UPDATE jobs SET state='queued' WHERE state='running'").run();
}
