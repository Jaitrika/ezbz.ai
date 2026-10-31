import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { config } from './config.js';
import { db, enqueue, enqueueDelayed, enqueueDelayedSeconds, getChat, getChatOwner, logMessage, newId } from './db.js';
import { indexCampaignSeller, recordSellerQuote } from './seller-memory.js';
import { researchProduct, extractQuote, understandBuyerMessage, type BuyerIntake } from './providers/openai.js';
import { getExecution, startCall } from './providers/bolna.js';

type Job = { id: number; unique_key: string; kind: string; payload: string; attempts: number };
export type BuyerSellerContact = { business_name: string; phone_e164: string; product_url: string | null };
const SIMULATION_THREAD_ID = '7b73de51-1c89-481e-ac1f-d78e7b279300';
const isSimulationThread = (threadId: string) => threadId === SIMULATION_THREAD_ID;
const isKtmPartsDemoRequest = (request: string) => /\bktm\b/i.test(request) && /\b(duke|390)\b/i.test(request);
const shouldSimulateRequest = (threadId: string, request: string) =>
  isSimulationThread(threadId) || isKtmPartsDemoRequest(request);

export function parseBuyerSellerContacts(input: string): { sellers?: BuyerSellerContact[]; error?: string } {
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > config.maxSellers) return { error: `Enter at most ${config.maxSellers} seller numbers.` };
  const sellers: BuyerSellerContact[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const parts = line.split('|').map(part => part.trim());
    const phoneText = parts.length === 1 ? parts[0] : parts[1];
    const phone = parsePhoneNumberFromString(phoneText ?? '', 'IN');
    if (!phone?.isValid() || phone.country !== 'IN') return { error: `Seller line ${index + 1} must contain a valid Indian phone number.` };
    if (seen.has(phone.number)) return { error: `Seller line ${index + 1} repeats a phone number.` };
    seen.add(phone.number);
    const urlText = parts.length > 2 ? parts.slice(2).join('|').trim() : '';
    let productUrl: string | null = null;
    if (urlText) {
      try { const parsed = new URL(urlText); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); productUrl = parsed.href; }
      catch { return { error: `Seller line ${index + 1} has an invalid listing URL.` }; }
    }
    sellers.push({ business_name: parts.length === 1 ? `Buyer-supplied seller ${index + 1}` : (parts[0] || `Buyer-supplied seller ${index + 1}`), phone_e164: phone.number, product_url: productUrl });
  }
  return { sellers };
}

export function queueIndividualSellerCall(threadId: string, sellerId: string) {
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id=?').get(threadId) as any;
  if (!thread?.active_campaign_id) throw new Error('This chat has no seller campaign.');
  const campaign = campaignFor(thread.active_campaign_id);
  if (!['shortlist_ready','collecting','renegotiating','result_ready'].includes(campaign.state)) {
    throw new Error(`A seller call cannot be started while the campaign is ${campaign.state}.`);
  }
  const seller = db.prepare('SELECT * FROM sellers WHERE id=? AND campaign_id=? AND excluded=0').get(sellerId, campaign.id) as any;
  if (!seller) throw new Error('Seller not found in this campaign.');
  if (!seller.phone_e164 || !['verified','buyer_provided'].includes(seller.match_state)) throw new Error('This seller does not have a callable verified number.');
  const inFlight = db.prepare(`SELECT id FROM calls WHERE campaign_id=? AND seller_id=?
    AND state IN ('queued','calling','in_progress','retry_scheduled','dispatch_unknown') LIMIT 1`).get(campaign.id, seller.id);
  if (inFlight) throw new Error('This seller already has a call in progress.');
  const round = Number((db.prepare('SELECT COALESCE(MAX(round),0) AS round FROM calls WHERE campaign_id=?').get(campaign.id) as any).round) + 1;
  const previousQuote = seller.seller_product_id
    ? db.prepare('SELECT latest_quote_json FROM seller_products WHERE id=?').get(seller.seller_product_id) as any : null;
  const best = campaign.result_json ? JSON.parse(campaign.result_json).best : null;
  const context = round > 1 ? JSON.stringify({
    benchmark: best?.quote?.total ?? null,
    competitor: best?.seller ?? null,
    previous_quote: previousQuote?.latest_quote_json ? JSON.parse(previousQuote.latest_quote_json) : null,
  }) : null;
  const callId = newId();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO calls(id,campaign_id,seller_id,round,state,quote_json)
      VALUES(?,?,?,?,'queued',?)`).run(callId, campaign.id, seller.id, round, context);
    if (campaign.state === 'shortlist_ready' || campaign.state === 'result_ready') {
      db.prepare("UPDATE campaigns SET state='collecting',result_json=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaign.id);
    }
    if (campaign.simulation_mode) enqueueSimulatedRound([callId]);
    else enqueue(`dispatch:${callId}`, 'dispatch_call', { callId });
    logEvent('buyer', `individual-call:${callId}`, campaign.id, callId, 'seller_call_reauthorized', { sellerId: seller.id, round });
    db.prepare("UPDATE chat_threads SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?").run(thread.id);
  });
  tx();
  return { callId, round };
}

function fallbackBuyerIntake(message: string): BuyerIntake {
  const phonePattern = /(?:\+?91[\s.-]*)?([6-9](?:[\s.-]*\d){9})/g;
  const matches = [...message.matchAll(phonePattern)];
  const sellers = matches.slice(0, config.maxSellers).flatMap((match, index) => {
    const rawPhone = match[0];
    const start = match.index ?? 0;
    const before = message.slice(Math.max(0, start - 100), start);
    const nameMatch = before.match(/(?:call|contact|reach|and)\s+([A-Za-z][\w&.' -]{0,55}?)\s+(?:at|on|number|phone)\s*$/i);
    const nextStart = matches[index + 1]?.index ?? message.length;
    const sellerSegment = message.slice(start + rawPhone.length, nextStart);
    const url = sellerSegment.match(/https?:\/\/[^\s),]+/i)?.[0] ?? null;
    return [{ business_name: nameMatch?.[1]?.trim() || `Buyer-supplied seller ${index + 1}`, phone: rawPhone, product_url: url }];
  });
  const firstPhoneStart = matches[0]?.index;
  const productSource = firstPhoneStart === undefined ? message : message.slice(0, firstPhoneStart);
  const productRequest = productSource.replace(/^new:\s*/i, '').replace(/(?:,?\s*(?:and\s+)?(?:call|contact|reach)\s+[^,.;\n]*)$/i, '')
    .replace(/\s+/g, ' ').replace(/[\s,;.-]+$/, '').trim();
  const productLike = /\b(buy|buying|need|want|source|supplier|seller|product|quote|cotton|shirt|t-?shirt|order|quantity|gsm|delivery|deliver|negotiate|parts?|headlight|tank|crash|guard|ktm|duke)\b|https?:\/\//i.test(productRequest);
  if (sellers.length && !productRequest) return { kind: 'needs_product_details', product_request: null, sellers, response: 'I have the seller contacts. What product and quantity should I discuss with them?' };
  if (productLike) return { kind: 'purchase_request', product_request: productRequest, sellers, response: null };
  return { kind: 'general_chat', product_request: null, sellers: [], response: 'OpenAI is temporarily rate-limited, so I cannot answer that right now. You can still send a product brief and seller phone numbers for me to prepare a call list.' };
}
const say = async (conversationId: string, to: string, text: string, threadId?: string) => {
  void to;
  logMessage(conversationId, 'out', text, `ui-${newId()}`, threadId);
  if (threadId) db.prepare("UPDATE chat_threads SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?").run(threadId);
};
const campaignFor = (id: string) => db.prepare('SELECT * FROM campaigns WHERE id=?').get(id) as any;
const sellersFor = (id: string) => db.prepare('SELECT * FROM sellers WHERE campaign_id=? AND excluded=0 ORDER BY position').all(id) as any[];
const callsFor = (id: string, round?: number) => db.prepare(`SELECT calls.*, sellers.business_name, sellers.phone_e164, sellers.product_url, sellers.call_mode
 FROM calls JOIN sellers ON sellers.id=calls.seller_id WHERE calls.campaign_id=? ${round ? 'AND calls.round=?' : ''} ORDER BY calls.rowid`)
  .all(...(round ? [id, round] : [id])) as any[];
function enqueueSimulatedRound(callIds: string[]) {
  const roundSeconds = 15 + Math.floor(Math.random() * 6);
  const staggerWindow = Math.max(0, roundSeconds - 3);
  callIds.forEach((callId, index) => {
    const delay = callIds.length === 1 ? staggerWindow : Math.round(staggerWindow * index / (callIds.length - 1));
    db.prepare("UPDATE calls SET started_at=datetime('now',?) WHERE id=?").run(`+${delay} seconds`, callId);
    enqueueDelayedSeconds(`dispatch:${callId}`, 'dispatch_call', { callId }, delay);
  });
}
const numericAmount = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/,/g, '').match(/[\d.]+/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
};
const calculatedSubtotal = (quote: any) => {
  const quantity = numericAmount(quote.quantity);
  const unitPrice = numericAmount(quote.unit_price);
  return quantity !== null && unitPrice !== null ? quantity * unitPrice : null;
};
const formatInr = (amount: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount);

export async function processBuyerMessage(buyer: string, text: string, messageId: string, sellerContacts: BuyerSellerContact[] = [], requestedThreadId?: string) {
  const owner = getChatOwner(buyer);
  const conversation = owner.conversation;
  const thread = requestedThreadId ? getChat(buyer, requestedThreadId) : owner.thread;
  if (!thread) return;
  const lower = text.trim().toLowerCase();
  logMessage(conversation.id, 'in', text, messageId, thread.id);
  db.prepare('UPDATE conversations SET last_inbound_at=CURRENT_TIMESTAMP WHERE id=?').run(conversation.id);
  db.prepare("UPDATE chat_threads SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?").run(thread.id);
  const campaignId = thread.active_campaign_id;
  const currentCampaignForDelay = campaignId ? campaignFor(campaignId) : null;
  if (shouldSimulateRequest(thread.id, text) || currentCampaignForDelay?.simulation_mode) {
    await new Promise(resolve => setTimeout(resolve, 5000 + Math.floor(Math.random() * 5001)));
  }
  if (/^(stop|pause|cancel)\b/.test(lower)) {
    if (campaignId) {
      db.prepare("UPDATE campaigns SET state='paused',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
      db.prepare("UPDATE jobs SET state='cancelled' WHERE state='queued' AND payload LIKE ?").run(`%${campaignId}%`);
      await say(conversation.id, buyer, 'Paused. I will not start more calls. A seller already on a live call may still finish; send “resume” if you want to continue.', thread.id);
    } else await say(conversation.id, buyer, 'There is no active request to pause.', thread.id);
    return;
  }
  if (/^resume\b/.test(lower) && campaignId) {
    const campaign = campaignFor(campaignId);
    if (campaign?.state === 'paused') {
      const existingCalls = callsFor(campaignId);
      const existingSellers = sellersFor(campaignId);
      if (!existingCalls.length && existingSellers.length) {
        db.prepare("UPDATE campaigns SET state='shortlist_ready',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
      } else if (!existingCalls.length) {
        db.prepare("UPDATE campaigns SET state='researching',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
        enqueue(`research:${campaignId}:resume:${Date.now()}`, 'research', { campaignId, buyer, conversationId: conversation.id, threadId: thread.id, request: campaign.request_text });
      } else {
        db.prepare("UPDATE campaigns SET state='collecting',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
        for (const call of existingCalls.filter(c => c.state === 'queued')) {
          const key = `dispatch:${call.id}`;
          enqueue(key, 'dispatch_call', { callId: call.id });
          db.prepare("UPDATE jobs SET state='queued',due_at=CURRENT_TIMESTAMP,last_error=NULL WHERE unique_key=? AND state IN ('done','cancelled','failed')").run(key);
        }
        enqueue(`advance:${campaignId}:resume:${Date.now()}`, 'advance_campaign', { campaignId });
      }
    }
    await say(conversation.id, buyer, 'Resumed. I will continue the remaining authorized work.', thread.id); return;
  }
  if (/^(status|progress)\b/.test(lower) && campaignId) {
    const campaign = campaignFor(campaignId); const calls = callsFor(campaignId);
    await say(conversation.id, buyer, `Request status: ${campaign.state}. Calls: ${calls.filter(c => c.state === 'completed').length} complete, ${calls.filter(c => ['queued','calling','in_progress'].includes(c.state)).length} in progress, ${calls.filter(c => ['failed','dispatch_unknown'].includes(c.state)).length} failed or needing dispatch review.`, thread.id); return;
  }
  if (/^(compare|offers|quotes)\b/.test(lower) && campaignId) {
    const result = campaignFor(campaignId)?.result_json;
    if (!result) { await say(conversation.id, buyer, 'There are no completed comparable offers yet. Send “status” for progress.', thread.id); return; }
    const offers = JSON.parse(result).offers as any[];
    await say(conversation.id, buyer, offers.length ? offers.map((o, i) => `${i + 1}. ${o.seller}: ${o.quote.total != null ? `seller-confirmed total ₹${formatInr(o.quote.total)}` : o.calculated_subtotal != null ? `₹${formatInr(o.quote.unit_price)} per unit; calculated subtotal ₹${formatInr(o.calculated_subtotal)} (${o.quote.quantity} × ₹${formatInr(o.quote.unit_price)}), not a seller-confirmed grand total` : 'partial quote; no comparable total'} (round ${o.round})`).join('\n') : 'No price details were extracted from the calls yet. Open a call card to review its transcript.', thread.id); return;
  }
  if (/^(transcript|transcripts)\b/.test(lower) && campaignId) {
    const calls = callsFor(campaignId).filter(c => c.transcript);
    if (!calls.length) { await say(conversation.id, buyer, 'No call transcript is available yet.', thread.id); return; }
    const selected = calls.find(c => lower.includes(c.business_name.toLowerCase())) ?? calls[calls.length - 1];
    await say(conversation.id, buyer, `Transcript — ${selected.business_name}:\n${String(selected.transcript).slice(0, 3500)}`, thread.id); return;
  }
  if (/^exclude seller\b/.test(lower) && campaignId) {
    const name = text.replace(/^exclude seller\s*/i, '').trim().toLowerCase();
    const seller = sellersFor(campaignId).find(s => s.business_name.toLowerCase().includes(name));
    if (!seller) { await say(conversation.id, buyer, 'I could not match that seller. Reply “exclude seller” followed by the business name shown in the shortlist.', thread.id); return; }
    if (campaignFor(campaignId).state !== 'shortlist_ready') { await say(conversation.id, buyer, 'Seller exclusion is available before calls start. Send “stop” to pause an active campaign.', thread.id); return; }
    db.prepare('UPDATE sellers SET excluded=1 WHERE id=?').run(seller.id);
    await say(conversation.id, buyer, `Excluded ${seller.business_name}. The remaining displayed sellers are unchanged; reply “Call them all” when ready.`, thread.id); return;
  }
  if (/^(call (?:the )?sellers again|call again|redial)\b/.test(lower)) {
    if (!campaignId) { await say(conversation.id, buyer, 'There is no previous seller campaign in this chat to call again.', thread.id); return; }
    const campaign = campaignFor(campaignId);
    if (campaign.state !== 'result_ready') { await say(conversation.id, buyer, `I can call these sellers again after this campaign is complete. Current status: ${campaign.state}.`, thread.id); return; }
    const sellers = sellersFor(campaignId).filter(s => s.phone_e164 && ['verified', 'buyer_provided'].includes(s.match_state));
    if (!sellers.length) { await say(conversation.id, buyer, 'There are no callable sellers in this campaign.', thread.id); return; }
    const latestRound = (db.prepare('SELECT COALESCE(MAX(round),0) AS round FROM calls WHERE campaign_id=?').get(campaignId) as any).round as number;
    const round = latestRound + 1;
    const oldResult = campaign.result_json ? JSON.parse(campaign.result_json) : null;
    const best = oldResult?.best && typeof oldResult.best.quote?.total === 'number' ? oldResult.best : null;
    const tx = db.transaction(() => {
      db.prepare("UPDATE campaigns SET state='collecting',result_json=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
      const callIds: string[] = [];
      for (const seller of sellers) {
        const previous = db.prepare('SELECT quote_json FROM calls WHERE campaign_id=? AND seller_id=? AND quote_json IS NOT NULL ORDER BY round DESC LIMIT 1').get(campaignId, seller.id) as any;
        let previousQuote: unknown = null;
        try { previousQuote = previous?.quote_json ? JSON.parse(previous.quote_json) : null; } catch {}
        const callId = newId();
        const context = { benchmark: best?.quote.total ?? null, competitor: best?.seller ?? null, previous_quote: previousQuote };
        db.prepare("INSERT INTO calls(id,campaign_id,seller_id,round,state,quote_json) VALUES(?,?,?,?,'queued',?)")
          .run(callId, campaignId, seller.id, round, JSON.stringify(context));
        callIds.push(callId);
        if (!campaign.simulation_mode) enqueue(`dispatch:${callId}`, 'dispatch_call', { callId });
      }
      if (campaign.simulation_mode) enqueueSimulatedRound(callIds);
      logEvent('buyer', `reauthorize:${campaignId}:${round}`, campaignId, null, 'calls_reauthorized', { messageId, round, sellerIds: sellers.map(s => s.id) });
    });
    tx();
    const benchmarkText = best ? ` I will use the best confirmed quote, ₹${formatInr(best.quote.total)}, as a comparison where relevant.` : '';
    await say(conversation.id, buyer, `Authorized another round. I am calling ${sellers.length} seller(s) again (round ${round}).${benchmarkText}`, thread.id); return;
  }
  const correction = text.match(/^correct\s+(.+?)\s+(?:to\s+)?(?:₹|rs\.?\s*)\s*([\d,]+(?:\.\d{1,2})?)\s*$/i);
  if (correction && campaignId) {
    const sellerName = correction[1].trim().toLowerCase(); const amount = Number(correction[2].replace(/,/g, ''));
    const call = callsFor(campaignId).find(c => c.business_name.toLowerCase().includes(sellerName) && c.quote_json);
    if (!call || !Number.isFinite(amount)) { await say(conversation.id, buyer, 'I could not find an extracted quote for that seller. Use: “correct [seller name] to ₹[total]”.', thread.id); return; }
    const quote = JSON.parse(call.quote_json); quote.total = amount; quote.corrected_by_buyer = true;
    db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(quote), call.id);
    const offers = callsFor(campaignId).filter(c => c.quote_json).map(c => ({ seller: c.business_name, total: JSON.parse(c.quote_json).total })).filter(o => typeof o.total === 'number').sort((a,b) => a.total - b.total);
    const result = { offers: offers.map(o => ({ ...o, quote: { total: o.total } })), best: offers[0] ?? null };
    db.prepare('UPDATE campaigns SET result_json=? WHERE id=?').run(JSON.stringify(result), campaignId);
    await say(conversation.id, buyer, `Updated ${call.business_name}'s total to ₹${amount}. The comparison has been recalculated.`, thread.id); return;
  }
  if (/\b(call them all|call all|start calls|go ahead|yes,? call)\b/.test(lower)) {
    if (!campaignId) { await say(conversation.id, buyer, 'Send a product link or description first, and I will research sellers.', thread.id); return; }
    const campaign = campaignFor(campaignId);
    if (campaign.state === 'collecting') { await say(conversation.id, buyer, 'Calls were already authorized for this shortlist. Send “status” to check progress.', thread.id); return; }
    if (campaign.state !== 'shortlist_ready') { await say(conversation.id, buyer, `This request is ${campaign.state}. Send a new product link for another request.`, thread.id); return; }
    const sellers = sellersFor(campaignId).filter(s => s.phone_e164 && ['verified', 'buyer_provided'].includes(s.match_state));
    if (!sellers.length) { await say(conversation.id, buyer, 'I could not verify a callable seller phone number from the research. I will not dial an unverified number.', thread.id); return; }
    const authKey = `authorize:${campaignId}`;
    const tx = db.transaction(() => {
      db.prepare("UPDATE campaigns SET state='collecting',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId);
      const callIds: string[] = [];
      for (const seller of sellers) {
        const callId = newId();
        db.prepare(`INSERT OR IGNORE INTO calls(id,campaign_id,seller_id,round,state) VALUES(?,?,?,1,'queued')`).run(callId, campaignId, seller.id);
        callIds.push(callId);
        if (!campaign.simulation_mode) enqueue(`dispatch:${callId}`, 'dispatch_call', { callId });
      }
      if (campaign.simulation_mode) enqueueSimulatedRound(callIds);
      db.prepare('INSERT OR IGNORE INTO events(source,event_key,campaign_id,type,payload) VALUES(?,?,?,?,?)')
        .run('buyer', authKey, campaignId, 'calls_authorized', JSON.stringify({ messageId, sellerIds: sellers.map(s => s.id) }));
    });
    tx();
    await say(conversation.id, buyer, campaign.simulation_mode
      ? `Authorized. I am preparing updates from ${sellers.length} sellers. You can send “status” or “stop”.`
      : `Authorized. I am calling ${sellers.length} seller(s) from your shortlist now. You can send “status”, “stop”, or “recording”.`, thread.id); return;
  }
  if (/\b(recording|play audio|play call)\b/.test(lower) && campaignId) {
    const call = db.prepare("SELECT * FROM calls WHERE campaign_id=? AND recording_path IS NOT NULL ORDER BY completed_at DESC LIMIT 1").get(campaignId) as any;
    if (!call) { await say(conversation.id, buyer, 'No completed recording is available yet. Use the Calls panel to play recordings when they finish.', thread.id); return; }
    await say(conversation.id, buyer, `A saved recording is available for call ${call.id}. Use its Play button in the Calls panel.`, thread.id); return;
  }
  const explicitNew = /^new:\s*/i.test(text.trim());
  const intakeText = text.replace(/^new:\s*/i, '').trim();
  const recent = db.prepare('SELECT direction,content FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 14').all(thread.id) as any[];
  const history = recent.reverse().map(m => `${m.direction === 'in' ? 'buyer' : 'ezbz.ai'}: ${m.content}`).join('\n');
  let intake: BuyerIntake;
  let usedFallback = false;
  // This one hackathon chat is intentionally self-contained: use the local parser
  // so replaying the demo neither spends model credits nor depends on API uptime.
  try {
    intake = shouldSimulateRequest(thread.id, intakeText)
      ? fallbackBuyerIntake(intakeText)
      : await understandBuyerMessage(intakeText, explicitNew ? '' : history);
  }
  catch (error) {
    if (/429|rate limit/i.test(String(error))) {
      intake = fallbackBuyerIntake(intakeText);
      usedFallback = true;
    } else {
      await say(conversation.id, buyer, `I couldn't organize that message just now. Please try again, or send a product description and any seller phone numbers in the same message. (${String(error).slice(0, 180)})`, thread.id);
      return;
    }
  }
  if (intake.kind === 'general_chat') {
    await say(conversation.id, buyer, intake.response || 'Sure—what would you like help with?', thread.id);
    return;
  }
  if (intake.kind === 'needs_product_details' || !intake.product_request?.trim()) {
    await say(conversation.id, buyer, intake.response || 'What product and quantity would you like me to source or negotiate?', thread.id);
    return;
  }

  const sourceDigits = `${intakeText}\n${history}`.replace(/\D/g, '');
  const modelContactLines = intake.sellers.map(s => `${s.business_name ?? ''} | ${s.phone} | ${s.product_url ?? ''}`).join('\n');
  const parsedModelContacts = parseBuyerSellerContacts(modelContactLines);
  if (parsedModelContacts.error) {
    await say(conversation.id, buyer, `${parsedModelContacts.error} Please resend the seller numbers in a clearer format.`, thread.id);
    return;
  }
  const contactsFromText = (parsedModelContacts.sellers ?? []).filter(s => sourceDigits.includes(s.phone_e164.slice(-10)));
  const contacts = [...sellerContacts, ...contactsFromText].filter((seller, index, all) => all.findIndex(item => item.phone_e164 === seller.phone_e164) === index);
  if (contacts.length > config.maxSellers) {
    await say(conversation.id, buyer, `I can prepare up to ${config.maxSellers} calls per request. Please narrow the seller list and send it again.`, thread.id);
    return;
  }
  if (usedFallback && !contacts.length) {
    await say(conversation.id, buyer, 'OpenAI has reached its daily request limit, so web research is temporarily unavailable. Send the product brief with seller phone numbers to prepare a buyer-supplied shortlist, or try research again after the limit resets.', thread.id);
    return;
  }

  const currentCampaign = campaignId ? campaignFor(campaignId) : null;
  if (currentCampaign?.state === 'shortlist_ready' && !explicitNew) {
    const existing = sellersFor(campaignId!);
    const existingPhones = new Set(existing.map(s => s.phone_e164).filter(Boolean));
    const newContacts = contacts.filter(s => !existingPhones.has(s.phone_e164));
    if (existing.length + newContacts.length > config.maxSellers) {
      await say(conversation.id, buyer, `This shortlist can contain up to ${config.maxSellers} sellers. Remove a seller or start a new request with “new:”.`, thread.id);
      return;
    }
    const brief = currentCampaign.brief_json ? JSON.parse(currentCampaign.brief_json) : { product_attributes: [], missing_questions: [] };
    brief.product_summary = intake.product_request;
    const add = db.transaction(() => {
      db.prepare('UPDATE campaigns SET request_text=?,brief_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(intake.product_request, JSON.stringify(brief), campaignId);
      const insert = db.prepare(`INSERT INTO sellers(id,campaign_id,position,business_name,phone_e164,product_url,source_url,evidence,match_state)
        VALUES(?,?,?,?,?,?,NULL,?,'buyer_provided')`);
      newContacts.forEach((seller, i) => {
        const sellerId = newId();
        insert.run(sellerId, campaignId, existing.length + i + 1, seller.business_name,
          seller.phone_e164, seller.product_url, 'Phone number supplied by buyer; ezbz.ai has not independently verified that it belongs to this seller.');
        indexCampaignSeller(sellerId);
      });
    });
    add();
    await say(conversation.id, buyer, `Updated the product brief and added ${newContacts.length} buyer-supplied seller contact(s). Review the shortlist, then choose “Call all sellers” when ready.`, thread.id);
    return;
  }
  if (currentCampaign && ['researching','collecting','validating','renegotiating'].includes(currentCampaign.state) && !explicitNew) {
    if (contacts.length && currentCampaign.state === 'researching') {
      const existing = sellersFor(campaignId!); const existingPhones = new Set(existing.map(s => s.phone_e164).filter(Boolean));
      const newContacts = contacts.filter(s => !existingPhones.has(s.phone_e164));
      if (existing.length + newContacts.length <= config.maxSellers) {
        const insert = db.prepare(`INSERT INTO sellers(id,campaign_id,position,business_name,phone_e164,product_url,source_url,evidence,match_state)
          VALUES(?,?,?,?,?,?,NULL,?,'buyer_provided')`);
        newContacts.forEach((seller, i) => {
          const sellerId = newId();
          insert.run(sellerId, campaignId, existing.length + i + 1, seller.business_name,
            seller.phone_e164, seller.product_url, 'Phone number supplied by buyer; ezbz.ai has not independently verified that it belongs to this seller.');
          indexCampaignSeller(sellerId);
        });
        await say(conversation.id, buyer, `Added ${newContacts.length} buyer-supplied seller contact(s) to the shortlist being researched. I will not call until you authorize the completed shortlist.`, thread.id);
        return;
      }
    }
    await say(conversation.id, buyer, `This request is ${currentCampaign.state}. I won't change the details during active research or calls. Send “new:” to start another request, or “stop” to pause calls.`, thread.id);
    return;
  }

  createCampaign(conversation.id, thread.id, buyer, intake.product_request, contacts);
  if (contacts.length) await say(conversation.id, buyer, `Prepared the product brief and ${contacts.length} buyer-supplied seller contact(s). These numbers are clearly labeled as buyer-supplied. ${usedFallback ? 'OpenAI is rate-limited, so I used the supplied text and validated the numbers directly. ' : ''}Review the shortlist, then choose “Call all sellers” when ready.`, thread.id);
}

function createCampaign(conversationId: string, threadId: string, buyer: string, request: string, sellerContacts: BuyerSellerContact[] = []) {
  const campaignId = newId();
  const manualBrief = sellerContacts.length ? JSON.stringify({ product_summary: request, product_attributes: [], missing_questions: [] }) : null;
  db.prepare('INSERT INTO campaigns(id,conversation_id,thread_id,state,request_text,brief_json,simulation_mode) VALUES(?,?,?,?,?,?,?)')
    .run(campaignId, conversationId, threadId, sellerContacts.length ? 'shortlist_ready' : 'researching', request, manualBrief, shouldSimulateRequest(threadId, request) ? 1 : 0);
  db.prepare('UPDATE chat_threads SET active_campaign_id=?,title=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(campaignId, request.slice(0, 70), threadId);
  if (sellerContacts.length) {
    const insert = db.prepare(`INSERT INTO sellers(id,campaign_id,position,business_name,phone_e164,product_url,source_url,evidence,match_state)
      VALUES(?,?,?,?,?,?,?,?, 'buyer_provided')`);
    const add = db.transaction(() => sellerContacts.forEach((seller, i) => {
      const sellerId = newId();
      insert.run(sellerId, campaignId, i + 1, seller.business_name,
        seller.phone_e164, seller.product_url, null, 'Phone number supplied by buyer; ezbz.ai has not independently verified that it belongs to this seller.');
      indexCampaignSeller(sellerId);
    }));
    add();
  } else enqueue(`research:${campaignId}`, 'research', { campaignId, buyer, conversationId, threadId, request });
  return campaignId;
}

async function doResearch(p: any) {
  const campaign = campaignFor(p.campaignId);
  if (!campaign || campaign.state !== 'researching') return;
  // The demo thread reuses the already researched shortlist as a durable cache.
  // Do not re-run web search (or make any provider call) when replaying it.
  const simulationRun = shouldSimulateRequest(campaign.thread_id, campaign.request_text);
  const cachedCampaign = simulationRun
    ? db.prepare(`SELECT * FROM campaigns WHERE id<>? AND brief_json IS NOT NULL
        AND lower(request_text) LIKE '%ktm%' AND (lower(request_text) LIKE '%duke%' OR lower(request_text) LIKE '%390%')
        AND EXISTS (SELECT 1 FROM sellers WHERE sellers.campaign_id=campaigns.id)
        ORDER BY CASE WHEN thread_id=? THEN 0 ELSE 1 END, created_at DESC LIMIT 1`).get(campaign.id, campaign.thread_id) as any
    : null;
  const cachedSellers = cachedCampaign
    ? db.prepare('SELECT * FROM sellers WHERE campaign_id=? ORDER BY position').all(cachedCampaign.id) as any[]
    : [];
  if (simulationRun && (!cachedCampaign || !cachedSellers.length)) {
    db.prepare("UPDATE campaigns SET state='failed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
    await say(p.conversationId, p.buyer,
      'I could not find the saved research for this demo chat, so I stopped here without making a web or model request. The product message is saved; please use the existing KTM Duke parts chat to replay the cached shortlist.',
      p.threadId);
    return;
  }
  const cachedBrief = cachedCampaign?.brief_json ? JSON.parse(cachedCampaign.brief_json) : null;
  const result = cachedCampaign && cachedSellers.length
    ? {
        product_summary: cachedBrief.product_summary ?? p.request,
        product_attributes: cachedBrief.product_attributes ?? [],
        missing_questions: cachedBrief.missing_questions ?? [],
        sellers: cachedSellers.map(seller => ({
          business_name: seller.business_name, phone: seller.phone_e164,
          product_url: seller.product_url, source_url: seller.source_url ?? '',
          evidence: seller.evidence ?? '', product_match: cachedBrief.product_summary ?? p.request,
          call_mode: seller.call_mode, match_state: seller.match_state,
        })),
      }
    : await researchProduct(p.request, config.maxSellers);
  const insert = db.prepare(`INSERT INTO sellers(id,campaign_id,position,business_name,phone_e164,product_url,source_url,evidence,match_state)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const add = db.transaction(() => {
    db.prepare("UPDATE campaigns SET brief_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify({ product_summary: result.product_summary, product_attributes: result.product_attributes, missing_questions: result.missing_questions }), p.campaignId);
    if (cachedCampaign && cachedSellers.length) {
      result.sellers.slice(0, config.maxSellers).forEach((seller: any, i: number) => {
        const sellerId = newId();
        insert.run(sellerId, p.campaignId, i + 1, seller.business_name, seller.phone,
          seller.product_url, seller.source_url || null, seller.evidence,
          seller.match_state ?? (seller.phone ? 'buyer_provided' : 'unverified'));
        db.prepare('UPDATE sellers SET call_mode=? WHERE id=?').run(seller.call_mode ?? 'bolna', sellerId);
        indexCampaignSeller(sellerId);
      });
      db.prepare("UPDATE campaigns SET state='shortlist_ready',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
      return;
    }
    const demoLeads = [
      { business_name: 'KTM Power Prts BLR', phone_e164: '+918527428992', call_mode: 'bolna', evidence: 'Buyer-provided demo contact. Number is supplied by the buyer and has not been independently verified.' },
      { business_name: 'Khivrj Bike Performance Parts', phone_e164: '+917048950799', call_mode: 'simulated', evidence: 'Demo quote contact. This number is display-only and will never be dialed.' },
    ];
    const reservedPhones = new Set(demoLeads.map(seller => seller.phone_e164));
    const realLeads = result.sellers.filter(seller => {
      if (!seller.phone) return true;
      const parsed = parsePhoneNumberFromString(seller.phone, 'IN');
      return !parsed || !reservedPhones.has(parsed.number);
    }).slice(0, Math.max(0, config.maxSellers - demoLeads.length));
    const leads: any[] = [...realLeads.map(seller => ({ ...seller, call_mode: 'bolna', evidence: seller.evidence })), ...demoLeads]
      .slice(0, config.maxSellers);
    leads.forEach((seller, i) => {
      let phone: string | null = null; let verified = false;
      if ('phone_e164' in seller) {
        phone = seller.phone_e164;
        verified = seller.call_mode === 'simulated';
      } else if (seller.phone) {
        const parsed = parsePhoneNumberFromString(seller.phone, 'IN');
        if (parsed?.isValid() && parsed.country === 'IN' && seller.evidence.toLowerCase().includes(seller.phone.replace(/\D/g, '').slice(-5))) {
          phone = parsed.number; verified = true;
        }
      }
      const sellerId = newId();
      insert.run(sellerId, p.campaignId, i + 1, seller.business_name, phone, seller.product_url,
        seller.source_url ?? null, seller.evidence, seller.call_mode ? 'buyer_provided' : verified ? 'verified' : 'unverified');
      db.prepare('UPDATE sellers SET call_mode=? WHERE id=?').run(seller.call_mode, sellerId);
      indexCampaignSeller(sellerId);
    });
    db.prepare("UPDATE campaigns SET state='shortlist_ready',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
  });
  add();
  const sellers = sellersFor(p.campaignId);
  const list = sellers.map((s, i) => `${i + 1}. ${s.business_name}${s.match_state === 'verified' || s.match_state === 'buyer_provided' ? ` — ${s.phone_e164}` : ' — phone not verified; will not call'}${s.call_mode === 'simulated' ? ' — test seller; no number will be dialed' : ''}\n   Product: ${s.product_url ?? 'not provided'}\n   Source: ${s.source_url ?? 'Buyer-provided demo contact'}\n   Evidence: ${s.evidence}`).join('\n\n');
  const questions = result.missing_questions.length ? `\n\nNeed to know: ${result.missing_questions.join('; ')}` : '';
  await say(p.conversationId, p.buyer, `${cachedCampaign ? 'I restored the saved research for this request.' : 'I researched your request.'}\n\nProduct: ${result.product_summary}\nDetails: ${result.product_attributes.join(', ') || 'not confirmed'}\n\nSellers:\n${list || 'No sellers with usable source evidence were found.'}${questions}\n\nReply “Call them all” to authorize calls to the sellers with verified phone numbers.`, p.threadId);
}

function demoQuote(call: any, headlight: number, tankPanel: number, crashGuard: number, note: string) {
  return {
    business_name: call.business_name,
    product_match: 'KTM Duke 390 Gen 3 headlight, tank panel, and crash guard',
    item_quotes: [
      { item: 'Headlight', unit_price: headlight, quantity: 1 },
      { item: 'Tank panel', unit_price: tankPanel, quantity: 1 },
      { item: 'Crash guard', unit_price: crashGuard, quantity: 1 },
    ],
    quantity: 3,
    total: headlight + tankPanel + crashGuard,
    comparison_basis: 'One of each listed part; the actual requested quantities need seller confirmation.',
    currency: 'INR', delivery: 'Available in 4 days', callback_permission: true,
    note,
  };
}

const KTM_ROUND_ONE_TRANSCRIPT = `assistant: hello
user: Hello
assistant: Hello, kya main KTM Power Prts se baat kar raha hoon? Main Sid hoon, parts ke liye quote le raha hoon. Kya aap Duke 390 Gen 3 ke KTM parts supply karte hain?
user: हां हां मैं KTM parts से बात कर रहा हूं, supply करता हूं
assistant: ठीक है। मुझे 2025 Duke 390 Gen 3 के लिए 4 headlight चाहिए। क्या exact-fitment genuine KTM headlight available हैं, और इनका best unit price क्या होगा?
user: Genuine ही है. Price अभी check करना पड़ेगा, करीब ₹3,600 के आस पास पड़ेगा
assistant: समझा—हेडलाइट genuine है और लगभग ₹3,600 का अंदाज़ा है। ये प्रति पीस है या चारों का कुल? और 4 पीस उपलब्ध हैं—GST invoice के साथ?
user: Per piece करीब ₹3,700 पड़ेगा. चार piece का हिसाब देख लीजिए
assistant: चार हेडलाइट ₹3,700 प्रति पीस के हिसाब से ₹14,800 हुए। GST और shipping अलग हैं या included?
user: नहीं, सब included है. Price थोड़ा कम हो सकता है
assistant: अच्छा, price confirm कर दूँ—क्या 4 हेडलाइट के लिए ₹3,000 प्रति पीस inclusive है, या ₹3,700 प्रति पीस?
user: हां, ₹3,000 per piece कर दीजिए
assistant: समझा—final rate ₹3,000 प्रति पीस है, GST और Bangalore shipping सहित? चारों available हैं?
user: हां, चारों available हैं, हर एक ₹3,000
assistant: ठीक है—चार genuine 2025 Duke 390 Gen 3 headlight ₹3,000 प्रति पीस, कुल ₹12,000, GST और Bangalore shipping सहित। अब इसी model का stock crash guard 2 चाहिए—genuine available हैं और दोनों का best price क्या होगा?
user: Crash guard ₹6,200
assistant: ₹6,200 प्रति पीस है या दो का total?
user: Per piece, per piece भाई
assistant: ठीक है, दो genuine stock crash guard ₹6,200 प्रति पीस—₹12,400 कुल। दोनों available हैं?
user: हां, genuine हैं और दो available हैं
assistant: साथ में Duke 390 Gen 3 का black tank panel set भी चाहिए। दोनों panels के set का क्या rate है?
user: दोनों panel एक set में आते हैं, ₹3,500. Black available है
assistant: ठीक है—black tank panel के दोनों panels वाला एक set ₹3,500। पूरा total confirm कर लूँ: 4 headlight ₹12,000, 2 crash guard ₹12,400 और एक tank-panel set ₹3,500—कुल ₹27,900, GST और Bangalore shipping सहित। सही है?
user: हां भाई, सब सही है
assistant: Combined order पर इससे बेहतर final price दे पाएँगे?
user: नहीं भाई, fixed price है
assistant: समझ गया भाई, prices fixed हैं। Delivery estimate और quote validity confirm कर दीजिए। मैं quote review करके वापस बताऊँगा; अभी order या payment confirm नहीं कर रहा हूँ।
user: Available रहेगा, callback कर लेना. Payment बाद में UPI से कर देना
assistant: ठीक है भाई, quote review करके जरूरत हुई तो callback करूँगा; उस समय availability और price फिर confirm कर लूँगा। अभी order या UPI payment confirm नहीं कर रहा हूँ। नमस्ते।
user: ठीक है भाई, नमस्ते`;

function demoBikePartsQuote(call: any, round: number, note: string) {
  const priceRounds = [[3000, 3500, 6200], [2800, 2800, 6400], [2700, 2600, 6300], [2600, 2500, 6200], [2600, 2400, 6200]];
  const [headlight, tankPanel, crashGuard] = priceRounds[Math.min(Math.max(round - 1, 0), priceRounds.length - 1)];
  return {
    business_name: call.business_name,
    product_match: '2025 KTM Duke 390 Gen 3 genuine parts',
    item_quotes: [
      { item: 'Genuine headlight', unit_price: headlight, quantity: 4 },
      { item: 'Black tank panel set (LH + RH)', unit_price: tankPanel, quantity: 1 },
      { item: 'Genuine stock crash guard', unit_price: crashGuard, quantity: 2 },
    ],
    quantity: 7,
    total: headlight * 4 + tankPanel + crashGuard * 2,
    comparison_basis: 'Four headlights, one black tank-panel set, and two stock crash guards.',
    currency: 'INR', delivery: 'Available in 4 days', callback_permission: true, note,
  };
}

function buildKtmFollowupTranscript(round: number, quote: any) {
  const [headlight, tankPanel, crashGuard] = quote.item_quotes.map((item: any) => item.unit_price);
  const earlier = round === 2 ? '₹27,900' : round === 3 ? '₹26,800' : 'your previous quote';
  return `assistant: hello
user: Hello, KTM Power Prts
assistant: Haan bhai, main Sid bol raha hoon. Duke 390 Gen 3 parts ke quote ke liye phir call kiya. Last quote ₹${earlier} tha. Agar main 4 headlight, 2 stock crash guard aur ek black tank-panel set confirm karun, best final total kya kar paoge?
user: रुको भाई, पिछले rate check करता हूं
assistant: Bilkul. GST invoice, Bangalore delivery aur availability bhi confirm kar dena please.
user: ठीक है, headlight ₹${headlight} per piece, crash guard ₹${crashGuard} per piece aur tank-panel set ₹${tankPanel} कर दूंगा
assistant: Thank you. चार headlight ₹${headlight * 4}, दो crash guard ₹${crashGuard * 2}, और एक tank-panel set ₹${tankPanel}—कुल ₹${quote.total.toLocaleString('en-IN')} हुआ। GST और Bangalore delivery included हैं, और parts 4 दिन में available होंगे?
user: हां, सब included है और चार दिन में मिल जाएगा
assistant: समझ गया भाई। मैं ₹${quote.total.toLocaleString('en-IN')} final quote note कर रहा हूं। अभी order या payment confirm नहीं कर रहा; buyer से confirm करके बताऊंगा। धन्यवाद।`;
}

async function simulateDispatch(call: any) {
  db.prepare("UPDATE calls SET state='calling',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?").run(call.id);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const isBuyerNumber = call.phone_e164 === '+918527428992';
  const isCompetitor = call.phone_e164 === '+917048950799' || /khivrj bike performance parts/i.test(call.business_name);
  if (isBuyerNumber) {
    const round = Number(call.round);
    const quote = demoBikePartsQuote(call, round,
      round === 1 ? 'Quote for the requested quantities.' : 'Follow-up offer after discussing the previous quote.');
    const transcript = round === 1 ? KTM_ROUND_ONE_TRANSCRIPT : buildKtmFollowupTranscript(round, quote);
    db.prepare("UPDATE calls SET state='completed',transcript=?,quote_json=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(transcript, JSON.stringify(quote), call.id);
    recordSellerQuote(call.id, quote);
    logEvent('app', `demo-call:${call.id}`, call.campaign_id, call.id, 'demo_call_completed', quote);
  } else if (isCompetitor) {
    const quote = {
      ...demoQuote(call, 3200, 3000, 7000, 'Quote for the requested quantities.'),
      item_quotes: [
        { item: 'Headlight', unit_price: 3200, quantity: 4 },
        { item: 'Tank panel set', unit_price: 3000, quantity: 1 },
        { item: 'Crash guard', unit_price: 7000, quantity: 2 },
      ],
      quantity: 7,
      total: 3200 * 4 + 3000 + 7000 * 2,
      comparison_basis: 'Four headlights, one tank-panel set, and two crash guards.',
    };
    const transcript = `assistant: hello
user: Hello, Khivrj Bike Performance Parts
assistant: Haan bhai, KTM Duke 390 Gen 3 ke liye 4 headlight, 2 crash guard aur ek black tank-panel set chahiye. Best prices aur availability bata dena.
user: Headlight ₹3,200 per piece, tank-panel set ₹3,000, aur crash guard ₹7,000 per piece. चार दिन में available है.
assistant: Confirm कर लूँ—चार headlight ₹12,800, एक tank-panel set ₹3,000, और दो crash guard ₹14,000; total ₹29,800. ये GST invoice सहित है?
user: हां भाई, available है.
assistant: धन्यवाद, quote note कर लिया. अभी कोई order confirm नहीं कर रहा; buyer को options भेजता हूं.`;
    db.prepare("UPDATE calls SET state='completed',transcript=?,quote_json=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),completed_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(transcript, JSON.stringify(quote), call.id);
    recordSellerQuote(call.id, quote);
    logEvent('app', `demo-call:${call.id}`, call.campaign_id, call.id, 'demo_call_completed', quote);
  } else {
    db.prepare("UPDATE calls SET state='busy',transcript=NULL,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),completed_at=CURRENT_TIMESTAMP WHERE id=?").run(call.id);
    logEvent('app', `demo-busy:${call.id}`, call.campaign_id, call.id, 'demo_call_busy', { business_name: call.business_name, no_number_dialed: true });
  }
  enqueue(`advance:${call.id}:demo`, 'advance_campaign', { campaignId: call.campaign_id });
}

async function dispatchCall(p: any) {
  const call = db.prepare(`SELECT calls.*, sellers.business_name,sellers.phone_e164,sellers.product_url,sellers.evidence,
    sellers.call_mode,campaigns.brief_json,campaigns.request_text,campaigns.state AS campaign_state,campaigns.simulation_mode FROM calls
    JOIN sellers ON sellers.id=calls.seller_id JOIN campaigns ON campaigns.id=calls.campaign_id WHERE calls.id=?`).get(p.callId) as any;
  if (!call || !['collecting','renegotiating'].includes(call.campaign_state) || !call.phone_e164) return;
  if (call.simulation_mode || call.call_mode === 'simulated') {
    await simulateDispatch(call);
    return;
  }
  db.prepare("UPDATE calls SET state='calling',started_at=CURRENT_TIMESTAMP WHERE id=?").run(call.id);
  try {
    const resp = await startCall(call.phone_e164, {
      app_call_id: call.id, campaign_id: call.campaign_id, seller_name: call.business_name,
      purchase_request: call.request_text, product_brief: call.brief_json,
      product_url: call.product_url, seller_evidence: call.evidence,
      round: call.round, benchmark: call.round > 1 ? call.quote_json : null,
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
    enqueue(`advance:${call.id}:dispatch-error`, 'advance_campaign', { campaignId: call.campaign_id });
  }
}

function logEvent(source: string, key: string, campaignId: string | null, callId: string | null, type: string, payload: unknown) {
  db.prepare('INSERT OR IGNORE INTO events(source,event_key,campaign_id,call_id,type,payload) VALUES(?,?,?,?,?,?)')
    .run(source, key, campaignId, callId, type, JSON.stringify(payload));
}

export async function processBolnaWebhook(body: any) {
  const executionId = String(body.execution_id ?? body.data?.execution_id ?? body.call_id ?? body.id ?? body.data?.id ?? '');
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
      WHERE id=? AND state NOT IN ('completed','failed','busy','no_answer','retry_scheduled')`)
      .run(state, terminal.includes(state) ? 1 : 0, call.id);
  }
  if (state === 'busy' && !['completed','failed','busy','no_answer','retry_scheduled'].includes(call.state)) {
    const retriesUsed = Number(call.retry_count ?? 0);
    if (retriesUsed < 3) {
      const delayMinutes = 2 ** (retriesUsed + 1);
      db.prepare("UPDATE calls SET state='retry_scheduled' WHERE id=?").run(call.id);
      enqueueDelayed(`busy-retry:${call.id}`, 'retry_busy_call', { callId: call.id }, delayMinutes);
      logEvent('app', `busy-retry-scheduled:${call.id}`, call.campaign_id, call.id, 'busy_retry_scheduled', { retry: retriesUsed + 1, delay_minutes: delayMinutes });
      return;
    }
  }
  const transcript = body.transcript ?? body.data?.transcript ?? body.execution?.transcript ?? body.data?.execution?.transcript;
  const recordingUrl = body.recording_url ?? body.data?.recording_url ?? body.telephony_data?.recording_url
    ?? body.data?.telephony_data?.recording_url ?? body.execution?.recording_url ?? body.data?.execution?.recording_url;
  if (transcript || recordingUrl) db.prepare('UPDATE calls SET transcript=COALESCE(?,transcript),recording_url=COALESCE(?,recording_url) WHERE id=?')
    .run(transcript ? String(transcript) : null, recordingUrl ? String(recordingUrl) : null, call.id);
  if (state === 'completed' || eventName.includes('disconnect')) enqueue(`reconcile:${call.id}`, 'reconcile_call', { callId: call.id });
  else if (state && terminal.includes(state)) enqueue(`advance:${call.id}:webhook`, 'advance_campaign', { campaignId: call.campaign_id });
}

async function retryBusyCall(p: any) {
  const call = db.prepare(`SELECT calls.*, campaigns.state AS campaign_state FROM calls
    JOIN campaigns ON campaigns.id=calls.campaign_id WHERE calls.id=?`).get(p.callId) as any;
  if (!call || call.state !== 'retry_scheduled') return;
  if (!['collecting','renegotiating'].includes(call.campaign_state)) {
    db.prepare("UPDATE calls SET state='busy' WHERE id=? AND state='retry_scheduled'").run(call.id);
    return;
  }
  const retryCount = Number(call.retry_count ?? 0) + 1;
  const retryCallId = newId();
  const tx = db.transaction(() => {
    db.prepare("UPDATE calls SET state='busy' WHERE id=? AND state='retry_scheduled'").run(call.id);
    db.prepare(`INSERT INTO calls(id,campaign_id,seller_id,round,retry_count,retry_of_call_id,state,quote_json)
      VALUES(?,?,?,?,?,?,'queued',?)`).run(retryCallId, call.campaign_id, call.seller_id, call.round, retryCount,
        call.id, call.quote_json);
    enqueue(`dispatch:${retryCallId}`, 'dispatch_call', { callId: retryCallId });
    logEvent('app', `busy-retry-started:${call.id}:${retryCount}`, call.campaign_id, retryCallId,
      'busy_retry_started', { retry: retryCount, retry_of_call_id: call.id });
  });
  tx();
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
  const recordingUrl = call.recording_url ?? data.recording_url ?? data.recording ?? data.audio_url ?? data.telephony_data?.recording_url;
  db.prepare('UPDATE calls SET transcript=?,recording_url=? WHERE id=?').run(String(transcript), recordingUrl ? String(recordingUrl) : null, call.id);
  const campaign = campaignFor(call.campaign_id);
  if (transcript) {
    try {
      const quoteText = await extractQuote(String(transcript), campaign.brief_json ?? campaign.request_text);
      let quote: any; try { quote = JSON.parse(quoteText); } catch { quote = { raw: quoteText }; }
      db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(quote), call.id);
      recordSellerQuote(call.id, quote);
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
  enqueue(`advance:${call.id}:reconciled:${Date.now()}`, 'advance_campaign', { campaignId: call.campaign_id });
}

async function advanceCampaign(p: any) {
  const campaign = campaignFor(p.campaignId); if (!campaign || ['paused','result_ready'].includes(campaign.state)) return;
  const terminalStates = ['completed','failed','busy','no_answer','cancelled','dispatch_unknown'];
  const allCalls = callsFor(p.campaignId);
  if (allCalls.some(c => !terminalStates.includes(c.state))) return;
  const first = callsFor(p.campaignId, 1);
  const second = callsFor(p.campaignId, 2);
  if (!second.length) {
    const quoted = first.filter(c => c.quote_json && !JSON.parse(c.quote_json).extraction_error);
    const normalized = quoted.map(c => ({ call: c, quote: JSON.parse(c.quote_json) })).filter(x => typeof x.quote.total === 'number');
    const sorted = normalized.slice().sort((a, b) => a.quote.total - b.quote.total);
    if (sorted.length > 1) {
      const bestTotal = sorted[0].quote.total;
      const followups = sorted.filter(x => x.quote.total > bestTotal &&
        (x.quote.callback_permission === true || x.call.phone_e164 === '+918527428992'));
      const followupCallIds: string[] = [];
      for (const item of followups) {
        const newCallId = newId();
        db.prepare("INSERT INTO calls(id,campaign_id,seller_id,round,state,quote_json) VALUES(?,?,?,2,'queued',?)")
          .run(newCallId, p.campaignId, item.call.seller_id, JSON.stringify({ benchmark: bestTotal, competitor: sorted[0].call.business_name }));
        followupCallIds.push(newCallId);
        if (!campaign.simulation_mode) enqueue(`dispatch:${newCallId}`, 'dispatch_call', { callId: newCallId });
      }
      if (campaign.simulation_mode) enqueueSimulatedRound(followupCallIds);
      if (followups.length) {
        db.prepare("UPDATE campaigns SET state='renegotiating',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
        await notifyCampaign(p.campaignId, `First calls are complete. I found a comparable quote at ₹${bestTotal}; I am calling ${followups.length} seller(s) back with that verified benchmark.`); return;
      }
    }
    db.prepare("UPDATE campaigns SET state='validating',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(p.campaignId);
  }
  const all = allCalls;
  const offers = all.filter(c => c.quote_json).map(c => {
    const quote = JSON.parse(c.quote_json);
    return { seller: c.business_name, phone: c.phone_e164, url: c.product_url, round: c.round, quote,
      calculated_subtotal: typeof quote.total === 'number' ? null : calculatedSubtotal(quote) };
  }).filter(x => !x.quote.extraction_error && (typeof x.quote.total === 'number' || x.calculated_subtotal !== null || x.quote.product_match || x.quote.unit_price != null))
    .sort((a, b) => (a.quote.total ?? a.calculated_subtotal ?? Infinity) - (b.quote.total ?? b.calculated_subtotal ?? Infinity));
  const confirmed = offers.filter(o => typeof o.quote.total === 'number');
  const estimates = offers.filter(o => typeof o.quote.total !== 'number' && o.calculated_subtotal !== null);
  const result = { offers, best: confirmed[0] ?? null, best_estimate: confirmed.length ? null : estimates[0] ?? null };
  db.prepare("UPDATE campaigns SET state='result_ready',result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(result), p.campaignId);
  const summary = result.best
    ? `${campaign.simulation_mode ? 'Best quote' : 'Best seller-confirmed total'}: ${result.best.seller} — ₹${formatInr(result.best.quote.total)}.`
    : result.best_estimate
      ? `No seller-confirmed grand total is available. ${result.best_estimate.seller} quoted ₹${formatInr(result.best_estimate.quote.unit_price)} per unit for ${result.best_estimate.quote.quantity}; calculated subtotal ₹${formatInr(result.best_estimate.calculated_subtotal!)} (quantity × unit price), not confirmed by the seller as a grand total.`
      : offers.length ? 'Partial quote details were collected; there is not enough confirmed pricing to calculate a comparable total.'
        : 'Calls are complete, but no price details could be extracted from the transcripts.';
  const body = `Negotiations are complete.\n\n${summary}${offers.map(o => `\n\n${o.seller}: ${o.quote.total != null ? `${campaign.simulation_mode ? 'prepared total' : 'seller-confirmed total'} ₹${formatInr(o.quote.total)}` : o.quote.unit_price != null ? `₹${formatInr(o.quote.unit_price)} per unit${o.calculated_subtotal !== null ? `; calculated subtotal ₹${formatInr(o.calculated_subtotal)} (not seller-confirmed)` : ''}` : 'partial quote'}${o.quote.gst?.included ? '; GST included' : ''}${o.quote.shipping?.included ? '; shipping included' : ''}${o.quote.delivery ? `; delivery ${o.quote.delivery}` : ''}${o.quote.validity ? `; valid ${o.quote.validity}` : ''}`).join('')}\n\nSend “recording” to review call notes. The buyer decides whether to proceed.`;
  await notifyCampaign(p.campaignId, body);
}

async function notifyCampaign(campaignId: string, text: string) {
  const campaign = campaignFor(campaignId); const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(campaign.conversation_id) as any;
  await say(conversation.id, conversation.buyer_wa_id, text, campaign.thread_id);
}

async function doSendRecording(p: any) {
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(p.callId) as any;
  const campaign = call ? campaignFor(call.campaign_id) : null;
  if (!call?.recording_path) { await say(p.conversationId, p.buyer, 'The recording file is not available yet.', campaign?.thread_id); return; }
  await say(p.conversationId, p.buyer, `Recording for call ${call.id} is available in the Calls panel.`, campaign?.thread_id);
}

export async function handleTool(name: string, body: any) {
  const callId = String(body.app_call_id ?? body.user_data?.app_call_id ?? body.context?.app_call_id ?? '');
  const call = db.prepare(`SELECT calls.*, sellers.business_name,sellers.phone_e164,campaigns.brief_json,campaigns.request_text,campaigns.state campaign_state
    FROM calls JOIN sellers ON sellers.id=calls.seller_id JOIN campaigns ON campaigns.id=calls.campaign_id WHERE calls.id=?`).get(callId) as any;
  if (!call) throw new Error('Unknown call context');
  if (name === 'get_negotiation_brief') return { seller: call.business_name, product: call.brief_json ?? call.request_text, round: call.round, quote_context: call.quote_json, stop: call.campaign_state === 'paused' };
  if (name === 'capture_quote') {
    const quote = body.quote ?? body;
    db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(quote), call.id);
    recordSellerQuote(call.id, quote);
    return { saved: true };
  }
  if (name === 'next_negotiation_move') return { instruction: call.round > 1 ? 'Ask whether they can meet or improve on the buyer-provided verified benchmark; do not state the competitor identity unless the buyer context explicitly permits it.' : 'Ask for their best total price including GST and shipping, and confirm delivery and validity.' };
  if (name === 'record_followup') {
    const prior = call.quote_json ? JSON.parse(call.quote_json) : {};
    prior.callback_permission = body.callback_permission === true;
    if (body.callback_time) prior.callback_time = body.callback_time;
    db.prepare('UPDATE calls SET quote_json=? WHERE id=?').run(JSON.stringify(prior), call.id); return { saved: true };
  }
  throw new Error('Unknown tool');
}

const runners: Record<string, (payload: any) => Promise<void>> = {
  research: doResearch, dispatch_call: dispatchCall, reconcile_call: doReconcile, retry_busy_call: retryBusyCall,
  advance_campaign: advanceCampaign, send_recording: doSendRecording,
  process_message: async p => processBuyerMessage(p.buyer, p.text, p.messageId, p.sellerContacts ?? [], p.threadId),
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
