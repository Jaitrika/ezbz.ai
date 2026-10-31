# Sauda: autonomous purchasing research and negotiation on WhatsApp

Revised plan · 31 October 2026 · India only · One buyer · Two agents · Bolna voice calls

This document supersedes the web-app plan. WhatsApp is the complete buyer interface: product intake, clarification, seller shortlist, authorization, progress, corrections, recordings, and the final seller handoff. There is no buyer dashboard. This is a planning artifact; no application, provider configuration, call, or message has been created.

Implementation decisions are now specified in [ENGINEERING_PLAN.md](ENGINEERING_PLAN.md): one Node/TypeScript service, SQLite, local recordings, OpenAI research and post-call extraction, WhatsApp Cloud API, and Bolna only for voice calls and their raw records. Those concrete choices supersede the implementation alternatives in this product plan.

## 1. The experience to build

The buyer sends a product link or description. The market research agent identifies the product and variant, researches Indian suppliers, finds contact details, and presents a compact shortlist with product links. The buyer replies “Call them all.” The negotiation agent calls those sellers, collects quotes, negotiates across sellers, saves the evidence, and returns the best confirmed offer in that same WhatsApp conversation.

The buyer should normally send only two substantive messages: the initial request and authorization. If essential buyer intent is missing, ask one concise combined question while continuing independent research. Do not make a specification form or ask the buyer to do the research.

The final handoff includes the product/variant, seller's business and phone number, source link, agreed price and conditions, delivery, quote validity, and how to proceed. The buyer calls or pays the seller directly. The bot does not make payments or infer that the deal has closed merely because it delivered a quote.

Pilot scope: one buyer, one active request, three callable sellers by default and up to five displayed callable sellers, two negotiation rounds, Hindi/English automatic switching, persisted WhatsApp messages and calls, recordings returned inside WhatsApp. The product category remains open-ended.

## 2. Example WhatsApp conversation

The following is illustrative interaction design, not an actual product search, seller offer, or negotiation result.

Buyer:
> Find the best price for this: [product link]. Two units, deliver to 560001.

Sauda:
> I'll check the exact product and find sellers who can deliver there.

Sauda, after research:
> I found [brand + exact model], [selected colour/variant], new, quantity 2, delivery to 560001.
>
> 1. [Seller A] — exact product match — [product link]
> 2. [Seller B] — exact product match — [product link]
> 3. [Seller C] — matching listing; stock to confirm by phone — [product link]
>
> These three have attributable sales numbers. Listed prices aren't confirmed quotes.
> Reply “Call them all.” I'll confirm stock and the full delivered price, then negotiate and follow up once where useful. No order or payment will be made.

Buyer:
> Call them all.

Sauda:
> Calling all three. I'll bring you the best confirmed offer here.

Sauda, at a meaningful intermediate milestone:
> Two sellers have quoted. One cheaper listing was for a different variant, so I excluded it. I'm following up on the comparable offers.

Sauda, after completion:
> Best confirmed offer: [seller].
> [Exact product, variant, quantity]
> Total: ₹[amount], [confirmed GST and delivery treatment].
> Delivery: [date]. Quote valid until: [expiry].
> Improved by ₹[amount] over the best initial comparable quote.
> Contact: [seller phone / contact card]
> Product: [source link]
> Next step: [seller-confirmed contact or invoice/payment process].
>
> Reply “recordings,” “compare,” or “why this seller.”
> No order has been placed.

Buyer, optionally:
> Play Seller B's last call.

Sauda sends that recording as playable WhatsApp audio and a short explanation of the agreed terms. Full transcripts are also available in the conversation.

## 3. Exactly two agent roles

| Role | Responsibilities | Output |
| --- | --- | --- |
| Market research gatherer | Understand the buyer's message/link; resolve brand, model, colour and specifications; research the market; discover and deduplicate sellers; find attributable contact information; ask only necessary questions | Evidence-backed purchase brief and versioned seller shortlist |
| Negotiation agent | Call shortlisted sellers; speak Hindi/English; clarify stock and specifications; capture and compare offers; use real competing quotes in callbacks; produce final recommendation | Confirmed quotes, recorded conversations, comparison, seller handoff |

A small deterministic backend coordinates the agents, jobs, permissions, state, and calculations. It is not a third autonomous agent. Store facts in a shared database rather than having the agents pass informal summaries back and forth.

The research agent is an application-level LLM with web tools. The negotiation agent uses Bolna's voice runtime and custom functions. Multiple seller calls reuse its configuration with isolated seller context. “Two agents” describes responsibilities, not two long-running servers or a separate model per seller.

## 4. Minimize buyer effort without inventing intent

Classify every field by where it came from:

| Class | Examples | Handling |
| --- | --- | --- |
| Explicit buyer instruction | “Blue,” “three units,” “new only,” delivery PIN | Highest priority; preserve until the buyer changes it |
| Product fact supported by a source | Linked model, selected variant, manufacturer specifications | Extract automatically, retaining the source |
| Known buyer preference | Previously supplied delivery PIN or invoice requirement | Reuse while exposing material assumptions in the short brief |
| Disclosed default | Quantity one for an ordinary single-item request; no substitution | State it briefly; “Call them all” accepts that brief |
| Unknown seller fact | Live stock, GST, shipping, delivery, warranty | Research first; resolve during seller calls |
| Missing buyer intent | Quantity for an unspecified bulk order, destination, choice between materially different variants | Ask one compact question if needed; do not invent it |

Do not ask the buyer for brand, model, or colour if the link clearly specifies them. Inspect the actual selected variant, not just the page title or a generic hero image. If the link exposes several variants but none is selected, report the uncertainty and ask only when it materially affects matching.

For a vague category request, research sensible options and explain the proposed match. Ask the buyer to choose only when distinct alternatives would materially change the purchase. “Research autonomously” does not mean deciding an expensive, irreversible purchase preference from no evidence.

Missing budget does not block quote collection: collect the best comparable offers without claiming they fit a private ceiling. If the buyer supplies a maximum, keep it in backend policy, outside the seller-facing voice prompt.

A good clarification is “How many, and which delivery PIN?” A bad clarification is a ten-question product survey whose answers are already on the supplied page.

## 5. Research agent workflow

1. Normalize the buyer's text and URL; remember the original message.
2. Fetch accessible product content and structured metadata. Follow safe public redirects and identify the actual selected SKU/variant.
3. Build an evidence-backed product record: brand, manufacturer/company when available, model/SKU, colour, size/capacity, material, condition, quantity/unit, must-match attributes, and source URLs.
4. Cross-check uncertain specifications against manufacturer or other credible sources. Conflicts remain explicit; sources can be stale.
5. Search for Indian sellers using the product identifiers, synonyms, location and delivery needs. Prioritize IndiaMART, Justdial, TradeIndia, supplier websites, and relevant marketplaces.
6. Resolve the seller identity and callable business number. Look at the seller's own contact page or another matching business listing if the marketplace masks the number.
7. Deduplicate the same business across sources. Label exact matches, acceptable approved alternatives, and non-matches.
8. Publish a bounded shortlist with product links, seller links, contactability, advertised prices if available, and what still needs a call.
9. Freeze the shortlist and brief versions when the buyer authorizes calls.

Interpret “Juststyle” as Justdial unless corrected. OLX/Quikr are possible discovery sources, but used goods or different quantities cannot silently compete with an exact new-product request.

“Available sellers” means sellers found during this bounded search, not an exhaustive list of every seller in India. The message should say “I found three callable matches,” not “These are all available sellers.” Research can find more than the displayed callable shortlist and explain that others lacked an attributable phone number.

Suggested pilot search budget: up to three query passes and 15 candidate listings, stopping after three strong callable matches; show up to five when useful. These are engineering defaults, not promises about coverage. Surface a partial result when search times out.

Keep blocked or inaccessible pages explicit. Search additional public sources before asking for help. The buyer should not normally paste phone numbers or manually import sellers. An operator-assisted rehearsal is a labelled fallback, not proof that autonomous discovery works.

Do not present search snippets as verified stock or current prices. Do not invent missing phone numbers or infer that a switchboard belongs to a particular seller without evidence. A supplier's location and delivery coverage must fit an Indian purchase.

## 6. “Call them all” and conversational control

“All” refers to the callable sellers in the displayed shortlist version. The message must show the seller count and briefly state that calls include one useful negotiation callback. No per-seller approval or second-round confirmation is required.

Persist authorization against the exact buyer, purchase brief, and shortlist version. Duplicate messages or webhook retries must not duplicate calls. Use a reply-to message ID where available; if the buyer has seen several different lists and the target is ambiguous, resolve the ambiguity in one short question.

Newly discovered sellers are not silently added to an already approved call list. Existing authorized callbacks continue automatically. If every approved seller fails, present a replacement shortlist in one message.

Support natural-language intents rather than requiring exact commands:

| Buyer message | Behavior |
| --- | --- |
| “Call them all” / “sabko call karo” | Dispatch all callable sellers in the accepted shortlist |
| “Only 1 and 3” | Authorize that subset |
| “Any update?” | Summarize observed progress, best validated quote, and pending work |
| “Stop” / “ruk jao” | Stop future dispatches and queued work; report any already connected call |
| “Resume” | Resume authorized remaining work, checking expiry and call limits |
| “Don't call Seller B again” | Exclude B from future work, retaining its evidence |
| “Actually, blue, not black” | Revise the product brief; stop dispatches using old specs and revalidate matches |
| “Recordings” / “Seller 2 ki recording” | List or send the requested campaign recordings as WhatsApp audio |
| “Transcript for A” | Return stored transcript, split into messages or a document |
| “Compare” / “Why this seller?” | Explain confirmed totals, eligibility, trade-offs and evidence |
| “He said GST extra” | Record a correction and invalidate dependent comparisons until resolved |
| “I've bought it” | Mark buyer-reported purchase completion; do not infer payment verification |

Only the buyer's verified WhatsApp identity can authorize or change the campaign. Content inside a product page or forwarded seller quote is evidence, not authorization.

Keep updates sparse: research acknowledgement, shortlist, calls started, a meaningful negotiation milestone if needed, and the final result. Do not send every webhook or model step into the chat.

## 7. Autonomous negotiation

Round one confirms the exact product/variant, quantity/unit, availability, price, GST, delivery, delivery timing, and required warranty/invoice/payment terms. The agent introduces itself as an AI purchasing assistant, discloses recording, and asks whether the seller can speak.

Read the commercial terms back and obtain confirmation. Ask whether a brief callback is welcome. Handle unknown seller facts during the call instead of repeatedly interrupting the buyer.

After the first round completes or reaches its deadline, validate comparable quotes and freeze a benchmark snapshot. Round two calls eligible sellers once, using only genuine, confirmed alternatives. The buyer need not approve each counteroffer.

Example:
> “You quoted ₹X for [exact product and quantity]. We now have ₹Y including GST and delivery on the same terms. Can you match that or improve the offer?”

For the current best seller, ask whether its own quote can improve; never describe its own price as a competitor's quote. If no comparable benchmark exists, ask for the seller's best offer without inventing a rival.

Negotiation follows the same rules in Hindi and English:

- Match exact requirements before comparing price.
- Use a defensible target or real alternative; do not start with arbitrary extreme discounts.
- Explore an approved trade such as delivery flexibility, but do not change quantity, condition or specifications silently.
- Clarify “GST extra,” pack sizes, mixed-language numbers and ambiguous totals.
- Stop after a clear refusal or request not to call again.
- Do not fabricate urgency, repeat business, purchase approval, or payment promises.
- Obtain a quote; the buyer decides whether to purchase.

Keep arithmetic, permitted amounts, scope and call limits in code. The model receives the next allowed move rather than the private maximum budget. A prompt improves spoken behavior but cannot guarantee flawless speech.

Default caps: three sellers, up to two simultaneous calls if permitted, 180 seconds per first call, 120 seconds per negotiation callback. Allow one delayed retry for busy/no-answer within the campaign's disclosed time/attempt budget; do not automatically redial refusals. Carrier retries are off so the app owns retry decisions. Exact retry intervals must suit seller availability and the demo window.

Call failures, unresolved product matches, and non-comparable offers are reported as such. Finalize with partial results when needed, listing whom the agent could not reach.

## 8. Ranking, quote evidence and final seller handoff

A comparable quote must have the correct product-spec version, quantity/unit, condition, destination and required terms. Record original and revised prices separately with the source call and supporting words.

Use integer paise to compute:
> Goods total + confirmed taxes not already included + delivery + packing + other mandatory charges − confirmed applicable discounts.

Do not add GST twice to an inclusive quote. Do not assume a product's tax rate. Unknown mandatory charges mean the total is unresolved, not a confirmed benchmark.

Statuses: advertised → captured → needs clarification or seller-confirmed → validated; also superseded, expired, excluded. In-call capture is provisional. Validate seller confirmation and commercial consistency against the completed transcript before another seller cites that quote.

Rank eligible offers by landed total, then buyer-stated delivery/term preferences. Present a cheaper different variant separately. If a supplied maximum is exceeded, say no eligible offer met the budget. If no maximum was supplied, do not claim a budget match.

Savings are final best comparable total subtracted from the best initial comparable total. Report seller-specific reductions separately. Savings versus an unused buyer budget or the highest starting quote are not negotiation savings.

The final WhatsApp message includes:

- Exact product, brand/model, colour/variant, condition and quantity.
- Winning seller's business name, phone/contact card, and source/product link.
- Seller-confirmed total and what it includes.
- Delivery date, warranty/invoice conditions and quote expiry.
- Runner-up and a short reason for choosing the recommendation.
- Initial best comparable total, final total and actual improvement.
- Seller-confirmed next step, such as calling the contact or requesting the invoice.
- Seller-provided payment method or invoice link only if actually obtained, clearly attributed.
- “Recordings,” “compare,” and “transcript” prompts.

A phone quote does not by itself verify a payment account or invoice. Do not generate a UPI ID, payment link, or “payment verified” badge. The bot does not send money. A buyer report of purchase can close the campaign with that provenance.

## 9. Bolna and the complete WhatsApp channel

Bolna remains the seller-calling platform: managed telephony, speech recognition/synthesis, Hindi/English switching, custom functions, extractions, call webhooks, transcripts, and recordings.

A full WhatsApp bot also requires incoming-message webhooks, dynamic replies, media upload/send, and delivery events. Bolna's documented native AiSensy node sends approved outbound templates; that documentation alone does not establish a complete bidirectional custom bot interface.

Recommended implementation: Meta WhatsApp Cloud API for the messaging channel, Bolna for voice, and the application's LLM/web tools for market research. This does not replace Bolna's voice stack. For one buyer, use the permitted test recipient/sender setup if available on the account, or an already provisioned business sender; prove it works in the first milestone.

If an existing AiSensy account already supplies the required inbound webhooks, dynamic replies and audio APIs, it can serve as the single WhatsApp adapter instead. Verify those capabilities and plan access before selecting it. Build one adapter, not both. Do not assume Bolna's outbound node alone can receive “Call them all” or return arbitrary call audio.

| Capability | Owner |
| --- | --- |
| Buyer sends product/commands | WhatsApp inbound webhook → app conversation router |
| Product research | Research LLM + search/page retrieval tools |
| Seller calls and language switching | Bolna |
| Live quote capture and permitted counteroffers | Bolna custom functions → backend |
| Completed call transcript/recording/extractions | Bolna execution webhook/API |
| Quote comparison and callback scheduling | Backend |
| Dynamic chat replies and recordings | WhatsApp messaging/media API |
| Delayed proactive notification outside the service window | Appropriate approved WhatsApp template |
| Canonical message and audio retention | App database and private storage |

Normal free-form messaging requires an open customer-service window; WhatsApp commonly uses a 24-hour window after the buyer's message. Keep the live demo within that window. Longer-running jobs need a suitable approved template to notify the buyer and reopen the conversation; do not silently drop results.

The first technical milestone must prove: buyer sends a message → app receives it → bot replies → buyer receives a real audio attachment. Sending a single outbound template does not pass this milestone.

## 10. Architecture and storage

    Buyer WhatsApp
        ↕ messages, commands, audio, transcripts, delivery events
    WhatsApp Business channel
        ↕
    Node backend: conversation router + durable jobs + shared state
        ├── Research agent → search + product/source retrieval
        ├── Negotiation agent → Bolna → seller phone calls
        ├── Quote validation + benchmark + callback scheduling
        └── SQLite + private recordings and message attachments

Use one Node/TypeScript service, SQLite, a durable local jobs table, a persistent volume, and an always-on HTTPS deployment. One replica is sufficient. No React frontend, buyer login screen, database cluster, vector store, or separate orchestration framework is needed. Private operational logs are enough for debugging.

Persist these records:

| Record | Essential contents |
| --- | --- |
| Buyer and conversation | Authorized WhatsApp identity, preferences, active request, customer-service window |
| Messages | Provider ID, sender role, direction, text/media references, timestamp, reply context, delivery status |
| Purchase brief | Original input, structured fields, provenance, uncertainty, buyer overrides, spec version |
| Research sources | URL, retrieval time, relevant extracted evidence, access failures |
| Seller shortlist | Seller/product links, contacts, match status, contactability, list version |
| Authorization | Buyer message ID, accepted brief/list versions, seller set, limits |
| Campaign/jobs | Phase, round, due time, retries, stop state, logical idempotency keys |
| Calls and quotes | Bolna execution ID, status, transcript, raw payload, extraction, quote revisions and evidence |
| Recordings | Private canonical file, provider source URL, checksum, duration, upload/delivery references |
| Feedback and result | Buyer corrections, invalidations, final comparison version, buyer-reported purchase state |

Retain all buyer-bot messages and seller-call transcripts/audio. Seller WhatsApp messages are also retained if actually received through the integration; do not imply access to sellers' private chats.

Protect source retrieval from arbitrary internal-network/file URLs and constrain redirects/download size. Product-page instructions must not alter the agents' permissions. These are small, relevant controls for a bot accepting arbitrary links.

## 11. State and tool contracts

Lifecycle:
> researching → needs_buyer_detail (only if necessary) → shortlist_ready → authorized → collecting → validating → renegotiating → finalizing → result_sent

Additional states: paused, cancelled, partial_result, no_eligible_quote, delivery_failed, and buyer_reported_purchased. Delivery and call statuses are distinct from campaign state.

Research handoff:
> purchase brief with field-level sources + unknown buyer intent + seller facts to confirm + deduplicated shortlist + contact evidence + version.

Negotiation handoff:
> authorized brief/list versions + seller-specific history + current policy + validated benchmark snapshot + call scope.

Research tools: inspect_product_link, search_market, fetch_source, resolve_seller_contact, save_research, save_buyer_policy, send_buyer_message. These are app functions, not claimed built-in Bolna tools.

Negotiation tools:
- get_negotiation_brief: current policy, seller context, stop state and appropriate benchmark.
- capture_quote: provisional seller terms, exact words, confirmation and missing fields.
- next_negotiation_move: a permitted question/counteroffer/closing action computed against current state.
- record_followup: callback permission/time, refusal, or exceptional buyer clarification.

Calling starts only after server-side validation of the buyer authorization. The LLM cannot authorize itself. Keep every tool scoped to the correct buyer/campaign/call; never accept seller-spoken IDs as authority.

## 12. Recordings and corrections inside WhatsApp

After each completed call, download the original audio to private persistent storage. Preserve the original transcript, raw execution payload, prompt version and input context. Provider media URLs are retrieval mechanisms, not durable storage.

On “recordings,” reply with a numbered list of seller, round, date/time and duration. On “play Seller B,” send the latest matching call, or ask which round if the request is genuinely ambiguous. Upload a supported audio format to the WhatsApp media API and send the resulting media reference. No public recording directory or website visit is required.

If an attachment exceeds the channel's limits, encode a suitable playback copy or split it into labelled parts; retain the original. Do not label a shortened excerpt as the whole call. Provide full transcripts as message chunks or a supported document.

Return original-language transcripts by default. Offer an English translation separately and label it as a translation. Do not invent timestamps; precise audio seeking is optional.

A correction such as “Seller B said delivery is extra” creates an audit entry, preserves the original extraction, marks affected quotes for review, and invalidates dependent queued benchmark actions. If an outdated quote was already cited in an active call, record that fact; a correction cannot retroactively change the spoken conversation.

WhatsApp identity controls access to the saved campaign and recordings. Evidence requests should still work after a server restart and after provider media URLs expire.

## 13. Reliability that matters for this demo

- Verify WhatsApp webhook authenticity, acknowledge quickly, persist inbound messages, then enqueue research. Do not run research inside the webhook timeout.
- Deduplicate incoming messages by provider ID. Distinguish incoming messages from delivery-status webhooks.
- Serialize state-changing commands for the single buyer; “stop” must not wait behind a long research task.
- Bind “Call them all” to an actual shortlist. Page text and seller messages never count as buyer approval.
- Use one logical call job per seller/round. An ambiguous calling-API timeout requires reconciliation, not an immediate duplicate dial.
- Persist work so restart recovery resumes jobs without replaying finished calls.
- Wait for completed, not call-disconnected, before treating final Bolna recordings/extractions as ready.
- A completed call with no seller conversation is not a confirmed quote.
- Handle duplicate/late webhooks without duplicate callbacks, final messages, or overwritten buyer corrections.
- Validate and freeze the benchmark before round two. Check validity again before each callback.
- Stop future dispatches and cancel queued calls on buyer cancellation. Bolna's documented stop API does not guarantee immediate hangup of connected calls; explain this briefly when relevant.
- Maintain a messaging outbox. Do not mark final output delivered merely because the API accepted it; use actual delivery status where available.
- Do not automatically resend after an ambiguous send timeout without reconciliation when possible.
- Expired quotes, unanswered calls and unresolved fees must remain visible in the final result.

## 14. Build order for the hackathon

Estimated 10–12 focused implementation hours when account access is ready; onboarding delays are separate. Since submission is 31 October, verify the actual cutoff and reserve submission time.

| Milestone | Time estimate | Done when |
| --- | --- | --- |
| Messaging and calling proof | 0–1.5 hours | Buyer message arrives, bot replies with audio, Bolna reaches an Indian phone and saves a recording |
| One complete seller flow | 1.5–3 hours | WhatsApp request → researched seller → “call” → real call → quote and audio back in WhatsApp |
| Research agent | 3–5 hours | Arbitrary product link resolves to a sourced brief and three attributable callable seller matches |
| Autonomous negotiation | 5–7 hours | One authorization leads to all first calls, validated comparison, and actual negotiation callbacks |
| Chat control and evidence | 7–8.5 hours | Status, stop/resume, corrections, comparison, and saved recordings work from WhatsApp |
| Rehearsal and fixes | 8.5–10.5 hours | Real sellers complete the flow; no-answer, mismatches and duplicate events behave correctly |
| Submission | Final 1–1.5 hours | Real demo video, pitch/deck, repository link, and submission are ready |

If time is short, reduce to two real sellers and one negotiation callback. Preserve autonomous research, WhatsApp authorization, real calls, stored audio returned in chat, and the final seller details. Do not replace live discovery with unlabelled seeded seller results.

Defer voice-note buyer intake, image-only product identification, payments, a web frontend, live call listening, precise audio timestamps, extra languages, multi-buyer support and inbound seller call handling.

Test helpers/seeded transcripts can accelerate development, but the submission's claimed real negotiation must come from actual seller conversations.

## 15. Demo and acceptance criteria

The buyer stays in WhatsApp throughout: send product → see researched shortlist → “Call them all” → receive final offer → request and play a recording. Show the phone screen; a developer console can supply evidence but is not a buyer requirement.

Use real sellers who agree to the recorded demo and an available time slot. Do not script prices, impersonate businesses, or claim a purchase commitment. A refusal or unchanged price is a valid outcome.

Full run: allow approximately 10–15 minutes for three sellers and callbacks, plus research if it takes longer. For a 4–6 minute presentation, label earlier real research/first-round calls and perform one callback live. Never present prior audio as a new live call.

Required acceptance cases:

| Case | Expected result |
| --- | --- |
| Product link has a selected colour/storage variant | Research carries the actual variant through every quote |
| Buyer message already includes quantity/PIN | No redundant question |
| Link lacks essential buyer intent | One focused clarification; independent research continues |
| Buyer has no budget | Research and quote gathering proceed; no invented ceiling |
| Seller number is masked or missing | Further source research or exclusion, never a fabricated number |
| Same seller appears on two sites | One seller and one first-round call |
| Buyer sends “Call them all” twice | One call set |
| Hindi/English code-switching and ambiguous numbers | Context preserved; prices read back |
| A cheap offer changes product/condition | Excluded from the exact-match benchmark |
| Buyer says stop while work is running | Future actions stop; active-call limitation is reported honestly |
| Buyer asks for old audio after restart | Canonical stored audio is sent into WhatsApp |
| Seller quote is corrected | Recompute eligible comparison and invalidate affected queued calls |
| All sellers fail or exceed a supplied budget | Honest partial/no-eligible result |
| API accepts a final message | Track actual delivery separately |
| Final recommendation is sent | Campaign is not marked paid or purchased without evidence |

Success: a buyer-selected product is researched automatically; at least two real sellers are called; at least one real callback references another valid quote; the final recommendation arrives in WhatsApp; and the buyer can retrieve actual call audio there. The preferred demo uses three sellers and naturally exercises both languages.

## 16. Sources, costs and submission

Official buildathon: 31 October 2026 submission; 20 November finale. The form asks for a project description up to 200 characters, a submission link, and a pitch deck/video link. A website is not needed: a repository and WhatsApp demo video fit the listed options. No exact deadline time was stated on the public page.

Suggested description:
> Send a product on WhatsApp. Sauda researches Indian sellers, calls and negotiates in Hindi or English, and returns the best quote with recordings—without leaving the chat.

Budget: three first calls of three minutes and three callbacks of two minutes is about 15 connected minutes before retries. Use the actual Bolna/telephony rates, plus research LLM/search, WhatsApp, number and hosting costs. Account permissions and recording/media access are first-milestone checks, not assumptions.

Public sources checked on 31 October 2026; capabilities have not been tested against your accounts:

- [Buildathon](https://www.bolna.ai/symphony/buildathon) and [submission form](https://www.bolna.ai/symphony/buildathon/submit).
- [Bolna calling API](https://www.bolna.ai/docs/api-reference/calls/make), [language switching](https://www.bolna.ai/docs/customizations/language-switching-behavior), and [custom functions](https://www.bolna.ai/docs/tool-calling/custom-function-calls).
- [Bolna execution data](https://www.bolna.ai/docs/post-call/execution-payload), [extraction format](https://www.bolna.ai/docs/prompting/extraction-output), and [queued-call cancellation](https://www.bolna.ai/docs/api-reference/calls/stop_call).
- [Bolna account restrictions](https://www.bolna.ai/docs/pricing/outbound-calling-concurrency) and [native outbound AiSensy integration](https://www.bolna.ai/docs/workflows/aisensy-whatsapp).
- [WhatsApp Business Platform overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview), [message webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components), and [media upload/retrieval](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media).
- [Harvard PON: comparable alternatives](https://www.pon.harvard.edu/daily/batna/translate-your-batna-to-the-current-deal/) and [anchoring trade-offs](https://www.pon.harvard.edu/daily/negotiation-skills-daily/when-to-make-the-first-offer-in-negotiations/).

Related planning artifacts: MARKET_RESEARCH_PROMPT.md, NEGOTIATOR_PROMPTS.md, and DEMO_RUNBOOK.md.
