import { db, newId } from './db.js';

function compact(value: string) {
  return value.toLowerCase().replace(/\b\d[\d,.]*\s*(?:units?|pieces?|pcs|qty|quantity|sets?|orders?)\b/gi, ' ')
    .replace(/\b(?:budget|under|below|maximum|max)\s*(?:₹|rs\.?\s*)?[\d,]+(?:\.\d+)?\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function sellerKey(seller: any) {
  if (seller.phone_e164) return `phone:${seller.phone_e164}`;
  if (seller.product_url) {
    try { const url = new URL(seller.product_url); return `url:${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`; } catch { /* use name key */ }
  }
  return `name:${compact(seller.business_name || 'unknown seller')}`;
}

export function indexCampaignSeller(campaignSellerId: string) {
  const seller = db.prepare(`SELECT s.*,c.request_text,c.brief_json FROM sellers s
    JOIN campaigns c ON c.id=s.campaign_id WHERE s.id=?`).get(campaignSellerId) as any;
  if (!seller) return null;
  const profileId = newId();
  db.prepare(`INSERT INTO seller_directory(id,seller_key,business_name,phone_e164) VALUES(?,?,?,?)
    ON CONFLICT(seller_key) DO UPDATE SET
      business_name=CASE WHEN excluded.business_name LIKE 'Buyer-supplied seller %' THEN seller_directory.business_name ELSE excluded.business_name END,
      phone_e164=COALESCE(excluded.phone_e164,seller_directory.phone_e164),updated_at=CURRENT_TIMESTAMP`)
    .run(profileId, sellerKey(seller), seller.business_name || 'Unknown seller', seller.phone_e164 || null);
  const profile = db.prepare('SELECT id FROM seller_directory WHERE seller_key=?').get(sellerKey(seller)) as { id: string };
  let brief: any = {};
  try { brief = seller.brief_json ? JSON.parse(seller.brief_json) : {}; } catch { /* keep request as label */ }
  const productName = String(brief.product_summary || brief.product_name || seller.request_text || 'Unspecified product').trim();
  const productKey = compact(productName) || `request:${seller.campaign_id}`;
  const productId = newId();
  db.prepare(`INSERT INTO seller_products(id,seller_directory_id,product_key,product_name) VALUES(?,?,?,?)
    ON CONFLICT(seller_directory_id,product_key) DO UPDATE SET product_name=excluded.product_name,updated_at=CURRENT_TIMESTAMP`)
    .run(productId, profile.id, productKey, productName);
  const product = db.prepare('SELECT id FROM seller_products WHERE seller_directory_id=? AND product_key=?').get(profile.id, productKey) as { id: string };
  db.prepare('UPDATE sellers SET seller_directory_id=?,seller_product_id=? WHERE id=?').run(profile.id, product.id, seller.id);
  return { sellerProductId: product.id, sellerDirectoryId: profile.id };
}

function amount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/,/g, '').match(/[\d.]+/)?.[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceInfo(quote: any): { price: number | null; basis: string | null } {
  for (const key of ['total', 'total_price', 'grand_total', 'total_amount']) {
    const price = amount(quote?.[key]); if (price !== null) return { price, basis: 'total' };
  }
  for (const key of ['unit_price', 'price_per_unit']) {
    const price = amount(quote?.[key]); if (price !== null) return { price, basis: 'unit' };
  }
  for (const key of ['price', 'amount']) {
    const price = amount(quote?.[key]); if (price !== null) return { price, basis: 'price' };
  }
  return { price: null, basis: null };
}

export function recordSellerQuote(callId: string, quote: unknown) {
  const call = db.prepare(`SELECT calls.id,calls.campaign_id,calls.seller_id,calls.round,calls.completed_at,s.seller_product_id
    FROM calls JOIN sellers s ON s.id=calls.seller_id WHERE calls.id=?`).get(callId) as any;
  if (!call) return;
  const indexed = call.seller_product_id ? null : indexCampaignSeller(call.seller_id);
  const productId = call.seller_product_id || indexed?.sellerProductId;
  if (!productId) return;
  const value = quote && typeof quote === 'object' ? quote : { raw: String(quote ?? '') };
  const info = priceInfo(value);
  const current = db.prepare('SELECT latest_price,latest_price_basis,latest_quote_call_id FROM seller_products WHERE id=?').get(productId) as any;
  const existingHistory = db.prepare('SELECT previous_price FROM seller_quote_history WHERE call_id=?').get(callId) as any;
  const previousPrice = existingHistory ? existingHistory.previous_price :
    (current?.latest_quote_call_id !== callId && current?.latest_price_basis === info.basis ? current.latest_price : null);
  const serialized = JSON.stringify(value);
  db.prepare(`INSERT INTO seller_quote_history(id,seller_product_id,campaign_id,campaign_seller_id,call_id,round,quote_json,price,price_basis,previous_price,quoted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,COALESCE(?,strftime('%Y-%m-%d %H:%M:%f','now')))
    ON CONFLICT(call_id) DO UPDATE SET quote_json=excluded.quote_json,price=COALESCE(excluded.price,seller_quote_history.price),
      price_basis=COALESCE(excluded.price_basis,seller_quote_history.price_basis),
      quoted_at=excluded.quoted_at`)
    .run(newId(), productId, call.campaign_id, call.seller_id, call.id, call.round, serialized, info.price, info.basis, previousPrice, call.completed_at);
  // Preserve the most recent actual price when a later call only confirms terms or a callback.
  if (info.price === null) return;
  db.prepare(`UPDATE seller_products SET latest_quote_json=?,latest_price=?,latest_price_basis=?,latest_quote_call_id=?,
    latest_quoted_at=COALESCE(?,strftime('%Y-%m-%d %H:%M:%f','now')),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(serialized, info.price, info.basis, call.id, call.completed_at, productId);
}

export function backfillSellerDatabase() {
  const sellers = db.prepare('SELECT id FROM sellers WHERE seller_directory_id IS NULL OR seller_product_id IS NULL').all() as Array<{ id: string }>;
  for (const seller of sellers) indexCampaignSeller(seller.id);
  const calls = db.prepare(`SELECT c.id,c.quote_json FROM calls c LEFT JOIN seller_quote_history h ON h.call_id=c.id
    WHERE h.call_id IS NULL AND c.state='completed' AND c.quote_json IS NOT NULL ORDER BY c.completed_at,c.rowid`).all() as any[];
  for (const call of calls) {
    try {
      const quote = JSON.parse(call.quote_json);
      if (!quote.extraction_error) recordSellerQuote(call.id, quote);
    } catch { /* skip invalid legacy quote data */ }
  }
}
