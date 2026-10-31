# Sauda engineering plan: one server, SQLite, OpenAI, and Bolna

> **Current direction:** The buyer interface is now a protected browser console; WhatsApp has been dropped. The original plan below is superseded where it describes the buyer channel. See [README.md](README.md) for the implemented flow.

31 October 2026 · Planning only · WhatsApp-only buyer interface · One buyer · India

## 1. Decisions

Build a small application, not an agent platform. Use one Node.js/TypeScript process, one SQLite database, and files on the server. Two agents are two sets of prompts/functions in this application; they do not need separate services.

| Concern | Decision |
| --- | --- |
| Buyer interface | WhatsApp Cloud API: incoming text/links, outgoing replies, contacts and audio |
| Application | Node.js 24 LTS, TypeScript, Fastify |
| Research and buyer understanding | OpenAI Responses API |
| Search | OpenAI hosted web_search; no separate paid search provider initially |
| Typed model results | OpenAI Structured Outputs with Zod schemas |
| Seller conversations | Bolna managed voice calls, Hindi/English automatic switching |
| Live dialogue model | A supported OpenAI model selected in Bolna; connect your own OpenAI key if desired |
| Post-call quote extraction | OpenAI in our backend; Bolna extractions are not the source of truth |
| Prices, ranking and limits | Ordinary TypeScript functions |
| Database | SQLite through better-sqlite3, direct SQL, no ORM |
| Files | Local persistent directory for audio, source evidence and transcripts |
| Background work | A jobs table and a small asynchronous worker in the same process |
| Deployment | One always-on service and one persistent volume, managed HTTPS |
| Buyer identity | One configured WhatsApp sender ID; no signup or account UI |

Use Bolna only for the live voice pipeline and its call records: telephony, audio, recognition, synthesis, dialogue, language switching, custom tool calls, transcripts and recordings. Research, coordination, comparisons and messaging belong to the app. There is no Bolna workflow or AiSensy requirement in this implementation.

Bolna documents support for connecting your own OpenAI credentials under Settings → Integrations. Backend OpenAI requests use your OpenAI API credits. The live dialogue can also use that key through Bolna if configured; it does not happen merely because the app has the key. Bolna/platform/telephony/speech charges remain separate according to the selected providers and account.

Do not build a custom real-time audio server just to move the dialogue model out of Bolna. Selecting an OpenAI model within Bolna preserves the simple implementation.

## 2. Scope that must work

The complete happy path:

> Product message → autonomous research → sourced seller shortlist → “Call them all” → first seller calls → validated quote comparison → negotiation callbacks → final WhatsApp offer → “play recording” → actual audio in WhatsApp.

Also include status queries, one necessary clarification, corrections, seller exclusion, stop/resume, failure results and recovery after a server restart.

Research up to ten sellers by default, with a hard configurable cap of ten, two negotiation rounds, two concurrent calls if the account supports them, and one active purchase request. Every seller in the displayed authorized list gets a first attempt; an unavailable number or a refusal produces an honest outcome, not a fabricated offer.

The agents obtain quotes. The buyer independently completes the purchase. Product facts should be researched; missing buyer intent should not be guessed. No budget is required to collect offers.

## 3. Architecture

    Buyer WhatsApp
          ↕
    WhatsApp Cloud API
          ↕ incoming webhook / outgoing messages and media
    One Fastify application
          ├── conversation router
          ├── research agent → OpenAI web search + structured extraction
          ├── negotiation coordinator → Bolna call API
          ├── Bolna tool handlers + call webhook receiver
          ├── quote validation and ranking
          ├── SQLite job runner + outgoing-message queue
          └── SQLite + local files
                         ↕
                OpenAI post-call extraction

Two responsibilities, not a framework:

- Research agent: understand the request, gather evidence, resolve the product, find sellers.
- Negotiation agent: conduct calls through Bolna, gather facts, negotiate, explain the final result.

The coordinator is deterministic code. Do not give an LLM direct SQL, arbitrary phone-dialing authority, or a free-running loop that decides when the campaign is finished.

## 4. Minimal repository

    src/
      server.ts                 Fastify startup, routes, graceful shutdown
      config.ts                 Environment validation and fixed limits
      db.ts                     Connection, SQL statements, transactions
      schema.sql                Initial tables and indexes
      schemas.ts                Zod contracts for model and tool results
      worker.ts                 Claim and run due jobs; recover unfinished work
      conversation.ts           Interpret buyer messages and apply commands
      research.ts               Product and seller research
      negotiation.ts            Call rounds, context and finalization
      quotes.ts                 Normalize money/units, validate, rank
      recordings.ts             Download, persist, upload and send audio
      providers/
        openai.ts               Responses, search and typed extraction
        whatsapp.ts             Signature check, send text/contact/media
        bolna.ts                Start/get/stop calls and normalize events
    prompts/
      research.md
      intent.md
      quote-extraction.md
      negotiator-en.md
      negotiator-hi.md
    tests/
      quotes.test.ts
      transitions.test.ts
      provider-events.test.ts
    data/                       Mounted persistent volume; ignored by Git
      sauda.sqlite
      recordings/<call-id>/
      research/<campaign-id>/
      transcripts/<call-id>.txt

Runtime dependencies: fastify, better-sqlite3, openai, zod, cheerio, decimal.js and libphonenumber-js. Use Node's fetch and crypto. FFmpeg is optional at first; add it only if the actual Bolna recording format needs conversion for WhatsApp playback.

No frontend build, LangChain, Agents SDK, Redis, Celery, vector database, object-storage service or service-to-service messaging is required.

## 5. Eight SQLite tables

Store frequently queried state in columns and flexible product/provider details in JSON text. Do not normalize every product attribute into a separate table.

| Table | Important fields |
| --- | --- |
| conversations | id, buyer_wa_id UNIQUE, preferences_json, active_campaign_id, last_inbound_at |
| messages | id, conversation_id, direction, provider_message_id UNIQUE, outgoing_key UNIQUE, content_json, send_state, delivery_state, reply_to_id, created_at |
| campaigns | id, conversation_id, state, round, brief_json, brief_version, shortlist_version, private_max_paise, policy_json, authorization_json, benchmark_json, result_json, deadline_at |
| sellers | id, campaign_id, shortlist_position, business_name, phone_e164, product_url, source_evidence_json, match_state, callback_permission, excluded |
| calls | id, campaign_id, seller_id, round, attempt, bolna_execution_id UNIQUE, state, context_json, transcript, recording_path, recording_state, extraction_state, last_provider_json |
| quotes | id, call_id, revision, spec_version, terms_json, total_paise, validation_state, evidence_json, supersedes_id, created_at |
| jobs | id, unique_key UNIQUE, kind, payload_json, state, priority, due_at, attempts, last_error, started_at |
| events | id, source, event_key UNIQUE, campaign_id, call_id, type, payload_json, created_at, applied_at |

Additional indexes/constraints:

- One active campaign per buyer in application logic.
- Calls unique by campaign, seller, round and attempt.
- Sellers deduplicated by campaign and attributable phone/business identity; shared switchboards remain unresolved rather than automatically merging unrelated businesses.
- Jobs indexed by state, priority and due_at.
- Quotes indexed by call_id and revision.
- Messages and events ordered by timestamp with a stable ID tie-breaker.

Enable WAL mode, foreign keys and a short busy timeout. Wrap related state changes and job insertion in a transaction. Never hold a SQLite transaction open while waiting for OpenAI, Bolna or WhatsApp.

The authorization JSON freezes the buyer message ID, brief/list versions, seller IDs, actual numbers and allowed rounds. Preserve old versions in events and call context instead of overwriting the only copy.

Audio belongs on disk, not in a database BLOB. Keep the original file and any transcoded playback copy. Original provider JSON and research evidence can also be saved as files when large.

## 6. Five model contracts

Use strict Zod schemas for:

| Contract | Minimum contents |
| --- | --- |
| BuyerIntent | action, campaign reference, seller selection, proposed updates, referenced message, unresolved ambiguity |
| PurchaseBrief | product identity/attributes, quantity/unit, destination, timing, required terms, provenance, missing buyer intent |
| ResearchResult | brief, candidate sellers, source references, contact evidence, match state, unresolved seller facts |
| ExtractedQuote | amounts/units, quantity, product match, GST, shipping, complete total if stated, delivery, validity, callback preference, confirmation evidence |
| ResultExplanation | concise explanation referencing only the code-selected result and its evidence |

Actions include new_request, amend_request, authorize_calls, status, stop, resume, exclude_seller, recordings, transcript, compare, correct_quote and purchased.

Parse known exact commands such as “stop,” “status” and “recordings” without a model. Use OpenAI for natural variations and context-dependent messages. Do not implement authorization with a substring check: “don't call them all” must not trigger calls.

Structured output validates shape, not truth. Refusals, incomplete responses, missing output and unsupported model features are ordinary errors. Allow at most one bounded repair attempt, then preserve the partial result and explain what is missing.

Use one configurable app model initially. The official web-search guide currently documents gpt-5.5 as a supported recommended path; confirm actual account access with a small search and typed extraction before fixing OPENAI_MODEL. Bolna's live model selection is separate and must use a model actually supported in that dashboard. Avoid building a model-routing system.

## 7. WhatsApp message processing

Receive:

1. Verify the webhook challenge for GET requests and signature for POST requests using the original request bytes.
2. Separate actual incoming messages from delivery/status events.
3. Check the sender against ALLOWED_BUYER_WA_ID.
4. Insert the provider message ID once; duplicate delivery returns success without creating new work.
5. Persist the message and enqueue processing in the same transaction; acknowledge promptly.
6. Interpret the message using the active campaign, recent buyer context and any quoted message ID.
7. Apply the command in code, then insert jobs or outgoing messages.

Keep the entire history in SQLite, but send only recent relevant messages plus the current structured state to OpenAI.

“Call them all” accepts the displayed shortlist and its brief. Create all first-round call jobs atomically. Repeated authorization cannot create a second set. If essential buyer intent is unresolved or the referenced list is ambiguous, ask one short question instead.

A new product/variant changes the brief version, pauses stale pending calls and revalidates sellers. Any already connected call may still finish; label its quote with its original specification version so it cannot silently enter the new comparison.

Send:

- Save outgoing messages in messages with a deterministic outgoing_key.
- A send_message job calls the WhatsApp API, then saves the returned provider message ID.
- Track queued/sending/accepted/failed separately from actual delivered/read states.
- Handle delivery events arriving before the send response is saved by retaining and reconciling them.
- Respect channel text limits; split long shortlists/transcripts into numbered messages.
- Use normal free-form messages inside the 24-hour customer-service window. Outside it, send an appropriate approved notification template; resume free-form details when the buyer replies. Sending a template does not itself reopen the window.

An outgoing API timeout can mean the message was accepted. Mark send_unknown and reconcile if possible rather than blindly creating repeated final messages. Do not claim exactly-once delivery where the external API cannot guarantee it.

## 8. Research implementation using OpenAI credits

Use a bounded two-stage approach, not a crawler framework.

Stage A: collect evidence.

- Fetch the buyer's public product URL with a timeout and response-size cap. Extract title, selected-variant information, JSON-LD, useful text and contact links using Cheerio.
- Use OpenAI Responses with the web_search tool for product identity, alternative sellers and contacts.
- Include web_search_call.action.sources and preserve URL citations and source metadata.
- Bias search toward India and the requested city. First use relevant marketplace/manufacturer domains, then expand to supplier-owned sites when needed.
- Follow accessible public sources to substantiate variant and business phone details. A search source URL alone does not prove a specific phone number or product match.
- Save relevant evidence excerpts, their source URLs and retrieval times.

Stage B: produce a typed result.

- Pass the gathered evidence to a separate Structured Outputs request for PurchaseBrief/ResearchResult.
- Keeping search and normalization separate avoids depending on every model/tool/schema combination working in one request.
- Validate source references, normalize numbers with libphonenumber-js, deduplicate sellers and discard unsupported contact claims.
- Query again only for unresolved material gaps, for at most three research passes and 15 candidate listings.
- Target three callable sellers. Return fewer with an honest explanation if evidence is insufficient.

Model-generated phone digits must be backed by an attributable retrieved excerpt/tool result and matching business context. If neither the page nor searchable source content establishes the number, it stays unverified and cannot be dialed.

Show source/product links beside each seller in WhatsApp. Preserve OpenAI search citations as visible usable URLs rather than losing them during normalization.

Do not use Playwright, login automation or CAPTCHA workarounds initially. If a page is blocked, research other public sources. If the exact product cannot be identified, ask one focused question. The success criterion is working research, not a simulated result dressed as search.

## 9. Bolna setup and integration

Create one multilingual negotiation agent in the Bolna dashboard:

- English and Hindi configured, with automatic switching.
- A suitable recognition/voice provider for each language.
- Short localized welcome, tool-wait and goodbye messages.
- The English and Hindi negotiation prompts.
- Fixed upper call duration and prompt-based closing.
- Four custom tools pointing at this backend.
- All relevant call-status webhooks.
- Automatic provider retries disabled; the app owns retries.
- OpenAI provider credentials connected if using your own key for live dialogue.

Use a single 180-second hard call cap initially and instruct callbacks to close sooner. Add a second preconfigured shorter-call agent only if measured results justify it. Do not mutate shared agent settings while concurrent calls are running.

Start calls with POST /call: agent_id, recipient_phone_number, optional owned from_phone_number, and user_data containing the approved brief, seller history, round, app call reference and permitted scope. Store the returned execution_id.

Bolna tool endpoints:

| Tool | Handler behavior |
| --- | --- |
| get_negotiation_brief | Read current brief/policy, seller questions, authorized benchmark, stop state |
| capture_quote | Validate primitive fields and save provisional seller facts; preserve exact quoted words |
| next_negotiation_move | Return a permitted clarification, counteroffer, request for best terms or closing instruction |
| record_followup | Save seller's callback permission/time, refusal, or exceptional buyer clarification |

Use primitive fields in Bolna function schemas and the documented custom_task configuration. Avoid mandatory fields that force a seller to provide an answer they do not know. Missing GST/shipping is allowed and produces an incomplete quote.

Authenticate tool requests with a configured secret and bind them to provider-injected call identity or tested trusted context substitution. Do not let an LLM-provided seller ID select arbitrary call records. Calls to unknown or mismatched execution IDs fail without returning another conversation's data.

next_negotiation_move should be fast code, not another synchronous research-model call on every voice turn. Compute allowed amounts and terms from the stored policy/benchmark. The live OpenAI dialogue model in Bolna handles natural phrasing.

## 10. Call completion, extraction and comparison

On every Bolna webhook, authenticate it, retain its raw payload and update state without regressing a terminal call.

- queued/ringing/in-progress are progress, not quotes.
- call-disconnected means the line ended but processing may still be underway.
- completed permits final transcript/recording retrieval; confirm there was meaningful seller speech.
- busy/no-answer/failed are explicit outcomes, not empty successful quotes.

A webhook may arrive before the start-call response is saved. Persist unmatched events and reconcile after execution mapping exists. Poll GET /executions/{id} on a bounded schedule when events or final artifacts are missing.

After a meaningful completed call, enqueue two independent jobs:

1. download_recording: save the original audio and transcript.
2. extract_quote: use OpenAI Structured Outputs over the final transcript and original call brief.

Do not depend on Bolna extraction schemas in this version. In-call captures are provisional hints; the final transcript plus seller confirmation is the authoritative evidence for the app's extraction. A high model-confidence score is not proof.

Quote validation checks exact product/condition/quantity, unit or pack basis, tax treatment, shipping, required terms, availability, expiry and confirmation. Save uncertain fields as null.

Use integer paise for money and decimal-safe operations for fractional quantities/rates. Prefer an explicitly confirmed inclusive total. Otherwise sum only confirmed mandatory components and avoid double-counting GST or discounts. If stated totals and components contradict each other, flag the offer for clarification.

Eligible means comparable and meeting the buyer's hard requirements and any supplied maximum. Sort by total, then stated delivery/term preferences. Explain exclusions rather than hiding them.

## 11. Two rounds without a complex agent loop

Campaign states:
> researching → needs_detail or shortlist_ready → collecting → validating → renegotiating → finalizing → result_ready

Keep pause/cancel and message delivery state separate. Authorization is persisted metadata, not an LLM decision.

First round:
- Dispatch all authorized sellers, bounded by concurrency.
- Allow one delayed retry per seller across the entire campaign for an eligible failed attempt; no retries for explicit refusals.
- Three sellers means at most nine attempts: two conversation rounds plus one retry each.
- A call job finishes after dispatch; it does not occupy a worker task for the entire phone conversation. The call record owns its ongoing state.

Barrier:
- Proceed only when all first-round calls and their quote extractions are settled, or a defined round deadline expires.
- Mark unresolved results as pending/unavailable; do not invent an offer to unblock the flow.
- Freeze the validated comparable benchmark and its source quote IDs.

Second round:
- Each eligible seller gets at most one negotiation callback, subject to callback permission and policy.
- A non-leading seller receives another seller's real comparable quote as the benchmark.
- The current best seller is asked to improve its own terms, without inventing a rival.
- A seller who cannot match the brief is excluded; a seller who might match it but has unresolved facts can use its callback for clarification.
- No third auction round. Once callbacks/extractions settle, finalize the best eligible quote and any unresolved alternatives.

At every external action, recheck campaign state, authorization and spec version. Expired/rejected benchmark evidence invalidates dependent queued callbacks. Recompute when possible; otherwise use a generic best-offer request or stop for the needed buyer choice.

Budget or instructions can change via WhatsApp. The backend validates future moves against the latest policy; active conversations obtain changes on their next tool read, not by magically rewriting already-spoken audio.

## 12. Recordings and final output

For each call, store:
> data/recordings/<internal-call-id>/original.<actual-format>
> data/transcripts/<internal-call-id>.txt

Use generated IDs for paths, temporary download files followed by an atomic rename, and verified media type/size. Keep provider recording URLs as metadata only. Authenticate recording retrieval only to the correct provider host; do not forward secrets through arbitrary redirects.

On a recording request:

1. Resolve the buyer/campaign/seller/round against SQLite.
2. Ensure the original file is available; recover from the provider if it is not.
3. Convert to a supported WhatsApp audio format if needed, keeping the original.
4. Upload via the WhatsApp media API and send the media ID to that buyer.
5. Save the message reference; re-upload later if the provider media expires.

Keep recordings private on the server. No public static /recordings directory or login website is required. Large files can be split into labelled parts, never silently truncated. An unavailable recording must be reported, not replaced with generated speech.

Render the final price/contact fields from validated database values. OpenAI may produce a short explanation from that fixed result; it may not pick a different price or invent terms. If explanation generation fails, the ordinary message template still sends the result.

Include exact item/variant/quantity, business/contact, product link, total/inclusions, delivery, validity, required invoice/warranty terms, actual savings basis, runner-up and next step. Seller-provided payment/invoice details retain that attribution. Do not mark an order paid/closed just because a quote was sent.

“Compare,” “why,” corrections, transcript requests and recording requests work from stored data without redoing web research.

## 13. Job runner and restart behavior

The jobs table is the queue. A one-second scheduler claims due work in a short transaction, marks it running and launches it asynchronously. Keep a small cap on concurrent tasks, one research task at a time, and independent call concurrency.

The HTTP server remains responsive while jobs wait on network requests. Exact stop commands and call-tool requests use short direct handlers; control messages receive higher priority than new research. No single awaited research job may block every other action.

Required job kinds:
> process_message, research, dispatch_call, reconcile_call, extract_quote, download_recording, advance_campaign, send_message, send_recording.

Most failures retry a small number of times with backoff and timeouts. External side effects need special handling:

| Interrupted work | Recovery |
| --- | --- |
| Research/extraction | Retry or reuse saved response; reject results for obsolete brief versions |
| Recording download | Retry safely using temporary files |
| Known active call | Reconcile its Bolna execution; never place a replacement call just because the app restarted |
| Call request timed out without an execution ID | Mark dispatch_unknown; inspect provider history/context before retrying; unresolved ambiguity needs operator attention |
| WhatsApp send timed out without message ID | Mark send_unknown; reconcile if possible; do not blindly flood the buyer |
| Queued call after stop | Attempt documented queued-call cancellation; retain actual outcome |
| Stale callback after correction | Cancel/invalidate it before dispatch; preserve history |

Unique job keys prevent duplicate scheduling but do not prove exactly-once behavior at an external provider. Preserve that distinction.

On restart, recover safe read/processing jobs and reconcile external side effects. One replica and one startup recovery pass are sufficient; no distributed lock service is needed.

## 14. HTTP surface and configuration

| Route | Purpose |
| --- | --- |
| GET /health | Process, database and storage readiness without secrets |
| GET /webhooks/whatsapp | Provider challenge verification |
| POST /webhooks/whatsapp | Incoming messages and outgoing delivery events |
| POST /webhooks/bolna | Call lifecycle events |
| POST /bolna/tools/:name | Allowlisted four tool handlers |

No public start-call endpoint is necessary. Calling authority originates from the authenticated WhatsApp conversation.

Environment:
> OPENAI_API_KEY, OPENAI_MODEL
> BOLNA_API_KEY, BOLNA_AGENT_ID, BOLNA_FROM_NUMBER
> BOLNA_WEBHOOK_SECRET, BOLNA_TOOL_SECRET
> WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
> WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_GRAPH_VERSION
> ALLOWED_BUYER_WA_ID, PUBLIC_BASE_URL, DATA_DIR, PORT

Use the supported current WhatsApp Graph version selected during setup rather than an old copied example. Secrets live in deployment configuration or an ignored local .env, not in prompts or source control.

Defaults in config.ts: up to ten sellers, two concurrent calls, two rounds, one failed-call retry per seller, three research passes, a campaign deadline, network timeouts, and bounded response sizes.

The arbitrary product-link fetcher must reject private/internal/file destinations, revalidate redirects and resolved addresses, cap downloads and avoid forwarding credentials. Provider calls and buyer messages are also scoped server-side. These are small controls directly required by the app's inputs, not a separate compliance project.

## 15. Deployment and storage

Use one always-on Railway service with one persistent volume mounted at DATA_DIR, or the same single-process setup on an existing VPS. Do not use an ephemeral/serverless filesystem.

A single Docker image or ordinary Node deployment is sufficient. Expose only HTTPS webhooks through the platform domain. Ensure the volume is writable and the database/recordings survive a redeploy.

Provide one backup command using SQLite's online backup facility plus a copy of the recordings directory. Do not copy only the live main database file while ignoring WAL. Run it before the final demo; no backup service is necessary.

Log campaign/call/job IDs, outcomes, errors and provider usage. Avoid dumping API keys and complete private messages into generic logs. The canonical evidence remains in the database and files.

## 16. Implementation milestones

Build working vertical slices, not all infrastructure first.

| Step | Deliverable | Completion check |
| --- | --- | --- |
| 1. Provider proof | WhatsApp receive/reply/audio, OpenAI search/typed output, Bolna test call/recording | All actual account permissions and keys work |
| 2. Skeleton | Fastify routes, SQLite, messages, jobs, volume | Duplicate incoming events do not duplicate work; restart preserves data |
| 3. Research | Link parsing, OpenAI search, sourced brief/sellers | Buyer message produces real seller/product links and attributable phone numbers |
| 4. One seller | WhatsApp authorization → Bolna → OpenAI quote extraction → reply | Actual quote and recording return to WhatsApp |
| 5. Multiple sellers | Concurrent calls, comparison, callback round | Another seller's confirmed quote is used in a real callback |
| 6. Controls/evidence | Stop/resume, corrections, compare, recordings/transcripts | Entire buyer experience works from WhatsApp |
| 7. Recovery/deployment | Unknown dispatch handling, late webhooks, outbox, backup | Restart does not lose evidence or blindly redial sellers |
| 8. Real rehearsal | Buyer-selected product, real sellers, final handoff | Complete campaign with real audio and WhatsApp delivery |

A 10–12-hour implementation is a working estimate only if external accounts and seller availability are ready. Prove the messaging channel and Indian outbound calling before spending hours polishing research prompts.

If time shrinks, use two sellers and one callback. Preserve the complete real flow. Do not replace research with an unlabelled seeded directory, recordings with generated audio, or WhatsApp with a screenshot.

## 17. Focused validation

Use small automated tests around money, state transitions and provider events, followed by real integration tests. Do not test prompts by asserting their exact wording.

Required checks:
- Inclusive GST is not added twice; unknown shipping prevents a confirmed landed-total ranking.
- Per-pack versus per-unit, fractional quantities and mismatched condition are handled.
- A missing buyer budget does not block research.
- A phone number without source evidence cannot be called.
- Repeated “Call them all” and duplicate webhooks do not create duplicate call jobs.
- A late event cannot regress a terminal call or overwrite a buyer correction.
- The current best seller is not shown its own quote as a competitor.
- Stop during research/calling prevents new work while reporting the connected-call limitation.
- Spec changes and quote corrections invalidate stale callbacks.
- Ambiguous dispatch is reconciled instead of blindly redialed.
- Recordings persist through restart and can be uploaded back into WhatsApp.
- A template sent outside the service window does not authorize arbitrary free-form follow-ups until the buyer replies.
- No confirmed discount or no eligible offer produces a truthful final message.

One complete real campaign is the final acceptance test: a buyer-selected product is researched, every shortlisted seller is attempted, comparable quotes drive a callback, and the buyer receives both the final seller details and playable recorded evidence in WhatsApp.

## 18. Sources and relationship to the other documents

This document resolves implementation choices for BUILDATHON_PLAN.md. Use MARKET_RESEARCH_PROMPT.md and NEGOTIATOR_PROMPTS.md as starting prompt content, and DEMO_RUNBOOK.md for the presentation. In this implementation, backend OpenAI extraction replaces Bolna-specific post-call extraction setup; Bolna remains responsible for calls and their raw records.

Checked public documentation; no account-specific API calls or live tests were performed for this plan:

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search): Responses web_search, source metadata and citations.
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): typed model results and SDK parsing.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): application-owned tools and execution.
- [Bolna provider credentials](https://www.bolna.ai/docs/providers): connect your own OpenAI key.
- [Bolna call API](https://www.bolna.ai/docs/api-reference/calls/make), [tool schema](https://www.bolna.ai/docs/tool-calling/custom-function-schema), [execution data](https://www.bolna.ai/docs/post-call/execution-payload).
- [WhatsApp service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages), [webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components), [media](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media).
