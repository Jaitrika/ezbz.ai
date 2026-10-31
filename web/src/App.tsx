import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ThinkingState } from './components/aicss/ThinkingState';
import { MessageActions } from './components/aicss/MessageActions';
import { DataTable } from './components/aicss/DataTable';
import { Orb } from './components/aicss/Orb';
import { VoiceChatAgent } from './components/aicss/VoiceChat';

type Chat = { id: string; title: string; updated_at: string; product?: string; first_message?: string };
type Message = { id: number; direction: 'in' | 'out'; content: string; created_at: string };
type Snapshot = { chatId: string; campaign: any; sellers: any[]; calls: any[]; messages: Message[] };
const api = async (url: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};
const dateLabel = (value?: string) => value ? new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const dbTimestampMs = (value?: string) => value ? new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')).getTime() : NaN;
const simulatedDateLabel = (value: string | undefined, campaign: any) => {
  if (!value || !campaign?.simulation_mode) return dateLabel(value);
  const startMs = dbTimestampMs(campaign.created_at);
  const valueMs = dbTimestampMs(value);
  if (!Number.isFinite(startMs) || !Number.isFinite(valueMs)) return dateLabel(value);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(startMs));
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value ?? 0);
  const virtualStart = Date.UTC(part('year'), part('month') - 1, part('day'), 14, 8);
  const virtualMs = virtualStart + Math.max(0, valueMs - startMs) * 30;
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(virtualMs);
};
const statusLabel = (value = '') => value.replaceAll('_', ' ');
const statusClass = (value = '') => `status-${value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
const maskPhoneNumber = (phone: string | null | undefined = '') => {
  phone ??= '';
  const digits = phone.replace(/\D/g, '');
  if (!digits) return 'Phone not listed';
  const country = phone.trim().startsWith('+') && digits.startsWith('91') ? '+91 ' : '';
  const national = country ? digits.slice(2) : digits;
  return `${country}${'•'.repeat(Math.max(0, national.length - 4))}${national.slice(-4)}`;
};
function VisibilityIcon({ visible }: { visible: boolean }) {
  return visible ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0112 5c5.5 0 9 7 9 7a16 16 0 01-3.1 3.9M6.2 6.3C3.9 7.8 2 12 2 12s3.5 7 10 7a10 10 0 003-.5"/></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
}

export default function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState('');
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [visiblePhones, setVisiblePhones] = useState<Set<string>>(() => new Set());
  const [callingSellerId, setCallingSellerId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [railWidth, setRailWidth] = useState(370);
  const feedRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedChatRef = useRef(chatId);
  selectedChatRef.current = chatId;
  const pending = pendingChatId === chatId;
  const shellStyle = { '--sidebar-width': `${sidebarWidth}px`, '--rail-width': `${railWidth}px` } as CSSProperties;
  const resizePane = (pane: 'sidebar' | 'rail', event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = pane === 'sidebar' ? sidebarWidth : railWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (pointer: PointerEvent) => {
      const delta = pointer.clientX - startX;
      if (pane === 'sidebar') {
        const max = Math.max(260, window.innerWidth - railWidth - 400);
        setSidebarWidth(Math.min(max, Math.max(185, initial + delta)));
      } else {
        const max = Math.max(340, window.innerWidth - sidebarWidth - 400);
        setRailWidth(Math.min(max, Math.max(270, initial - delta)));
      }
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
    window.addEventListener('pointercancel', end, { once: true });
  };
  const keyboardResize = (pane: 'sidebar' | 'rail', event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 48 : 16);
    if (pane === 'sidebar') setSidebarWidth(width => Math.min(Math.max(260, window.innerWidth - railWidth - 400), Math.max(185, width + delta)));
    else setRailWidth(width => Math.min(Math.max(340, window.innerWidth - sidebarWidth - 400), Math.max(270, width + delta)));
  };
  const refreshChats = useCallback(async () => {
    const result = await api('/api/chats');
    setChats(result.chats);
    if (!selectedChatRef.current && result.defaultChatId) setChatId(result.defaultChatId);
  }, [chatId]);
  const refresh = useCallback(async () => {
    if (!chatId) return;
    try {
      const result = await api(`/api/state?chatId=${encodeURIComponent(chatId)}`);
      if (selectedChatRef.current !== chatId) return;
      setSnapshot(result);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [chatId]);
  useEffect(() => { refreshChats().catch(e => setError(String(e))); }, [refreshChats]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => { refresh(); refreshChats(); }, 2200);
    return () => window.clearInterval(timer);
  }, [refresh, refreshChats]);
  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [snapshot?.messages.length, pending]);

  const createChat = async () => {
    try {
      const created = await api('/api/chats', { method: 'POST', body: JSON.stringify({}) });
      selectedChatRef.current = created.chatId;
      setChatId(created.chatId); setSnapshot(null); setText(''); setEditingMessageId(null);
      await refreshChats();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const deleteChat = async (chat: Chat) => {
    if (deletingChatId) return;
    setDeletingChatId(chat.id); setError('');
    try {
      const result = await api(`/api/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
      setChats(result.chats);
      if (selectedChatRef.current === chat.id) {
        const nextChatId = result.defaultChatId;
        selectedChatRef.current = nextChatId;
        setChatId(nextChatId);
        setSnapshot(null); setText(''); setEditingMessageId(null);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDeletingChatId(null); }
  };
  const callSeller = async (seller: any) => {
    if (!chatId || callingSellerId) return;
    setCallingSellerId(seller.id); setError('');
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/sellers/${encodeURIComponent(seller.id)}/call`, { method: 'POST', body: '{}' });
      await refresh(); await refreshChats();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCallingSellerId(null); }
  };
  const submit = async (event?: FormEvent, override?: string) => {
    event?.preventDefault();
    const message = (override ?? text).trim();
    if (!message || pendingChatId || !chatId) return;
    const submittedChatId = chatId;
    const previousMessageId = Math.max(0, ...(snapshot?.messages.map(item => item.id) ?? []));
    setPendingChatId(submittedChatId); setError(''); if (!override) setText('');
    try {
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ text: message, chatId }) });
      setEditingMessageId(null);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 500));
        try {
          const result = await api(`/api/state?chatId=${encodeURIComponent(submittedChatId)}`);
          const inbound = [...result.messages].reverse().find((item: Message) => item.id > previousMessageId && item.direction === 'in' && item.content === message);
          if (selectedChatRef.current === submittedChatId) setSnapshot(result);
          if (inbound && result.messages.some((item: Message) => item.id > inbound.id && item.direction === 'out')) break;
        } catch { /* keep the thinking state visible through transient polling errors */ }
      }
      await refreshChats();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); if (!override) setText(message); }
    finally { setPendingChatId(current => current === submittedChatId ? null : current); }
  };
  const messages = snapshot?.messages ?? [];
  const calls = snapshot?.calls ?? [];
  const sellers = snapshot?.sellers ?? [];
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    const maxHeight = 200;
    const contentHeight = composer.scrollHeight;
    composer.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    composer.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [text, chatId]);
  const showSellerPanel = Boolean(snapshot?.campaign && sellers.length > 0);
  const brief = snapshot?.campaign?.brief ?? {};
  const liveCalls = calls.filter(call => !['completed','failed','busy','no_answer','cancelled'].includes(call.state)).length;
  const tableRows = useMemo(() => sellers.map((seller: any) => {
    const sellerCalls = calls.filter((call: any) => call.seller_id === seller.id);
    const latest = sellerCalls.at(-1);
    const quote = seller.latest_quote ?? latest?.quote ?? {};
    const amount = quote.price ?? quote.total_price ?? quote.quote ?? quote.amount;
    return { seller: seller.business_name, quote: amount != null ? `₹${amount}` : statusLabel(latest?.state ?? seller.match_state), terms: [quote.moq && `MOQ ${quote.moq}`, quote.delivery_time, quote.payment_terms].filter(Boolean).join(' · ') };
  }), [sellers, calls]);

  return <div className={`shell ${showSellerPanel ? 'has-seller-panel' : 'chat-only'}`} style={shellStyle}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><VoiceChatAgent mono className="brand-avatar"/></span><span>ezbz.ai<small>VOICE PROCUREMENT</small></span></div>
      <button className="new-chat" onClick={createChat}><span>＋</span> New negotiation</button>
      <div className="side-label">CHATS <span>{chats.length}</span></div>
      <nav className="chat-list" aria-label="Negotiation chats">{chats.map(chat => <div key={chat.id} className={`chat-item ${chat.id === chatId ? 'selected' : ''}`}><button className="chat-item-select" type="button" onClick={() => { selectedChatRef.current = chat.id; setChatId(chat.id); setSnapshot(null); setText(''); setEditingMessageId(null); }}><span className="chat-item-icon">◌</span><span className="chat-item-copy"><strong>{chat.title || 'New chat'}</strong><small>{chat.product || chat.first_message || 'Start a product search'}</small></span></button><button className="chat-delete" type="button" aria-label={`Delete chat ${chat.title || 'New chat'}`} title="Delete chat" disabled={deletingChatId === chat.id} onClick={() => void deleteChat(chat)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>)}</nav>
    </aside>

    <div className="resize-handle resize-sidebar" role="separator" aria-label="Resize chat history panel" aria-orientation="vertical" aria-valuemin={185} aria-valuemax={Math.max(260, window.innerWidth - railWidth - 400)} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0} onPointerDown={event => resizePane('sidebar', event)} onKeyDown={event => keyboardResize('sidebar', event)} />

    <main className="center">
      <section className="conversation-area">
        <div className="message-feed" ref={feedRef}>
          {!messages.length && <div className="welcome-card"><VoiceChatAgent mono className="welcome-agent-avatar"/><div className="eyebrow">BUYER'S DESK</div><h2>Start with a product link<br/>or a buying brief.</h2><p>We’ll identify matching sellers, confirm the shortlist here, then call and negotiate in English or Hindi.</p><div className="suggestions"><button onClick={() => setText('I need 500 custom printed cotton T-shirts, 180 GSM, delivered to Bengaluru. Find sellers and negotiate the best bulk rate.')}>Find custom T-shirt suppliers <span>↗</span></button><button onClick={() => setText('Research this product and find suppliers: ')}>Research a product link <span>↗</span></button></div></div>}
          {messages.map(message => <article key={message.id} className={`message ${message.direction === 'in' ? 'buyer-message' : 'agent-message'}`}><div className="message-avatar">{message.direction === 'in' ? 'Y' : <VoiceChatAgent mono/>}</div><div className="message-main"><div className="message-meta"><b>{message.direction === 'in' ? 'You' : 'ezbz.ai'}</b><time>{simulatedDateLabel(message.created_at, snapshot?.campaign)}</time></div><div className="message-body">{message.content}</div><div className="message-actions-row"><MessageActions text={message.content} sentAt={new Date(message.created_at)} onCopy={value => navigator.clipboard?.writeText(value)} />{message.direction === 'in' && <button className="edit-message-button" type="button" onClick={() => { setText(message.content); setEditingMessageId(message.id); window.setTimeout(() => { composerRef.current?.focus(); document.querySelector('.composer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 0); }}>Edit &amp; resend</button>}</div></div></article>)}
          {pending && <div className="message agent-message"><div className="message-avatar"><VoiceChatAgent mono/></div><div className="message-main"><div className="message-meta"><b>ezbz.ai</b><span className="live-thinking"><Orb variant="B2" size={18}/><ThinkingState/></span></div><div className="thinking-card"><span className="typing-dots"><i/><i/><i/></span><span>{['Searching the Indian wholesale market…','Checking seller details and product fit…','Getting the negotiation brief ready…'][Math.floor(Date.now()/3200)%3]}</span></div></div></div>}
          {error && <div className="inline-error">{error}</div>}
        </div>
        <form className={`composer ${editingMessageId !== null ? 'is-editing' : ''}`} onSubmit={submit}>
          {editingMessageId !== null && <div className="editing-indicator"><span>Editing your message</span><small>Send to post the revised message.</small><button type="button" onClick={() => { setEditingMessageId(null); setText(''); }}>Cancel</button></div>}
          <div className="composer-shell"><textarea ref={composerRef} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder="Describe the product, paste a link, or tell me what to do…" rows={2}/><div className="composer-tools"><span>Enter to send <kbd>↵</kbd> <span className="hint-separator">·</span> Shift + Enter for new line</span><button className="send-button" aria-label="Send message" title="Send" disabled={!text.trim() || pending}>↑</button></div></div><div className="composer-caption">ezbz.ai researches and negotiates with your approval. Calls are recorded for review.</div></form>
      </section>
    </main>

    {showSellerPanel && <div className="resize-handle resize-rail" role="separator" aria-label="Resize seller details panel" aria-orientation="vertical" aria-valuemin={270} aria-valuemax={Math.max(340, window.innerWidth - sidebarWidth - 400)} aria-valuenow={Math.round(railWidth)} tabIndex={0} onPointerDown={event => resizePane('rail', event)} onKeyDown={event => keyboardResize('rail', event)} />}

    {showSellerPanel && <aside className="right-rail">
      <div className="rail-header"><div><div className="eyebrow">LIVE CAMPAIGN</div><h2>Seller intelligence</h2></div><span className={`campaign-pill ${snapshot?.campaign ? 'active' : ''}`}><i/>{snapshot?.campaign ? statusLabel(snapshot.campaign.state) : 'No campaign'}</span></div>
      <div className="rail-content">
        <section className="metric-row"><div className="metric"><span>SELLERS FOUND</span><strong>{sellers.length}<small> / 10</small></strong></div><div className="metric"><span>ACTIVE CALLS</span><strong>{liveCalls.toString().padStart(2,'0')}<small> live</small></strong></div><div className="metric"><span>ROUNDS</span><strong>{calls.reduce((max: number, call: any) => Math.max(max, Number(call.round || 0)),0)}<small> total</small></strong></div></section>
        {snapshot?.campaign && <div className="control-row"><button onClick={() => void submit(undefined, 'status')}>↻ Refresh status</button><button onClick={() => void submit(undefined, 'call sellers again')} disabled={!sellers.length}>↗ Call sellers again</button>{['calling','negotiating','researching','paused'].includes(snapshot.campaign.state) && <button className="pause-control" onClick={() => void submit(undefined, snapshot.campaign.state === 'paused' ? 'resume' : 'stop')}>{snapshot.campaign.state === 'paused' ? '▶ Resume' : 'Ⅱ Pause'}</button>}</div>}
        <section className="rail-section"><div className="section-heading"><h3>Product brief</h3><span className="section-count">01</span></div>{snapshot?.campaign ? <><p className="product-brief">{snapshot.campaign.request_text}</p>{Object.entries(brief).filter(([key, value]) => typeof value === 'string' && value && !['summary','product_name'].includes(key)).slice(0,6).map(([key,value]) => <div className="detail-line" key={key}><span>{key.replaceAll('_',' ')}</span><b>{String(value)}</b></div>)}</> : <div className="empty-state">Product details will appear once you share a link or brief.</div>}</section>
        <section className="rail-section sellers-section">
          <div className="section-heading"><h3>Seller shortlist</h3><span className="section-count">{String(sellers.length).padStart(2,'0')}</span></div>
          {sellers.length ? sellers.map((seller:any) => {
            const sellerCalls=calls.filter((c:any)=>c.seller_id===seller.id);
            const last=sellerCalls.at(-1);
            const state=last?.state || seller.match_state;
            const phoneVisible=visiblePhones.has(seller.id);
            const quote=seller.latest_quote ?? last?.quote;
            const latestHistory=seller.quote_history?.find((entry:any)=>entry.price!=null);
            const raised=latestHistory?.price != null && latestHistory?.previous_price != null && latestHistory.price > latestHistory.previous_price;
            const activeCall=sellerCalls.some((c:any)=>['queued','calling','in_progress','retry_scheduled','dispatch_unknown'].includes(c.state));
            const canCall=!!seller.phone_e164 && ['verified','buyer_provided'].includes(seller.match_state) && ['shortlist_ready','collecting','renegotiating','result_ready'].includes(snapshot?.campaign?.state) && !activeCall;
            return <div className="seller-card" key={seller.id}>
              <div className="seller-avatar">{String(seller.business_name||'?').slice(0,1).toUpperCase()}</div>
              <div className="seller-info">
                <div className="seller-name-row"><b>{seller.business_name}</b><span className={`mini-status ${statusClass(state)}`}>{statusLabel(state)}</span></div>
                {seller.catalog_product_name && <div className="seller-product-name">{seller.catalog_product_name}</div>}
                <div className="seller-subline"><span className="seller-phone">{phoneVisible ? seller.phone_e164 || 'Phone not listed' : maskPhoneNumber(seller.phone_e164)}</span>{seller.phone_e164 && <button className="phone-visibility" type="button" aria-label={phoneVisible ? `Hide ${seller.business_name} phone number` : `Show ${seller.business_name} phone number`} aria-pressed={phoneVisible} title={phoneVisible ? 'Hide phone number' : 'Show phone number'} onClick={() => setVisiblePhones(previous => { const next = new Set(previous); if (next.has(seller.id)) next.delete(seller.id); else next.add(seller.id); return next; })}><VisibilityIcon visible={phoneVisible}/></button>}{seller.match_state && <span> · {statusLabel(seller.match_state)}</span>}</div>
                <div className="seller-actions">{seller.product_url && <a href={seller.product_url} target="_blank" rel="noreferrer">Product ↗</a>}{seller.source_url && <a href={seller.source_url} target="_blank" rel="noreferrer">Source ↗</a>}</div>
                <div className="seller-call-action"><button type="button" disabled={!canCall || callingSellerId !== null} onClick={() => void callSeller(seller)}>{callingSellerId === seller.id ? 'Queueing call…' : activeCall ? 'Call in progress' : 'Call this seller'}</button>{last && <span>Latest call · round {last.round}</span>}</div>
                {quote && (quote.total != null || quote.total_price != null || quote.price != null || quote.unit_price != null || quote.amount != null) && <div className="seller-quote">{seller.call_mode === 'simulated' ? 'Quote' : 'Latest recorded price'}: <b>₹{quote.total ?? quote.total_price ?? quote.price ?? quote.unit_price ?? quote.amount}</b>{quote.unit_price != null && <span> / unit</span>}{quote.moq && <span> · MOQ {quote.moq}</span>}{quote.item_quotes?.map((item: any) => <div className="quote-item-line" key={item.item}>{item.item}: ₹{item.unit_price.toLocaleString('en-IN')} each</div>)}</div>}
                {latestHistory?.price != null && <div className={`quote-history-note ${raised ? 'price-raised' : ''}`}>
                  {raised ? `↑ Price rose ₹${latestHistory.price - latestHistory.previous_price} vs the previous quote` : latestHistory.previous_price != null ? `Previous comparable quote: ₹${latestHistory.previous_price}` : 'First recorded quote for this product'}
                  <span> · Round {latestHistory.round} · {dateLabel(latestHistory.quoted_at)}</span>
                </div>}
                {seller.quote_history?.length > 1 && <details className="seller-history"><summary>Quote history ({seller.quote_history.length})</summary>{seller.quote_history.slice(0,5).map((entry:any,i:number)=><div key={`${entry.round}-${entry.quoted_at}-${i}`}>Round {entry.round}: {entry.price != null ? `₹${entry.price}${entry.price_basis==='unit'?' / unit':''}` : 'Price not captured'} <time>{dateLabel(entry.quoted_at)}</time></div>)}</details>}
              </div>
            </div>;
          }) : <div className="empty-state">Seller matches and evidence will show here after research.</div>}
        </section>
        {!!tableRows.length && <section className="rail-section quotes-section"><div className="section-heading"><h3>Quote comparison</h3><span className="section-count">LIVE</span></div><DataTable rows={tableRows}/></section>}
        {!!calls.length && (
          <section className="rail-section calls-section">
            <div className="section-heading"><h3>Call activity</h3><span className="section-count">{calls.length}</span></div>
            {calls.map((call: any, index: number) => (
              <div className="call-card" key={call.id}>
                <div className="call-head"><span className="call-number">{String(index + 1).padStart(2, '0')}</span><b>{call.business_name}</b><span className={`mini-status ${statusClass(call.state)}`}>{statusLabel(call.state)}</span></div>
                <div className="call-meta">Round {call.round} · {call.started_at ? simulatedDateLabel(call.started_at, snapshot?.campaign) : 'Waiting to connect'}{call.simulation_mode || call.call_mode === 'simulated' ? '' : ''}</div>
                {call.recording_path && <audio controls preload="none" src={`/api/recordings/${encodeURIComponent(call.id)}`} />}
                {call.transcript && <details><summary>{call.simulation_mode || call.call_mode === 'simulated' ? 'View call notes' : 'Review transcript'}</summary><pre>{call.transcript}</pre></details>}
              </div>
            ))}
          </section>
        )}
        {snapshot?.campaign?.result && <section className="best-deal"><span className="best-icon">✦</span><div className="eyebrow">BEST NEGOTIATED QUOTE</div><h3>{snapshot.campaign.result.business_name || snapshot.campaign.result.seller || 'Seller quote'}</h3><strong>₹{snapshot.campaign.result.price ?? snapshot.campaign.result.total_price ?? snapshot.campaign.result.amount ?? 'See quote'}</strong><p>{snapshot.campaign.result.summary || snapshot.campaign.result.terms || 'Quote received from the negotiation campaign.'}</p></section>}
      </div>
      <div className="rail-footer"><span className="connection-dot"/> Calls and recordings are available for review.</div>
    </aside>}
  </div>;
}
