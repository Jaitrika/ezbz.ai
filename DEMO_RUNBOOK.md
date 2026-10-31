# Sauda: browser-console real-demo runbook

> **Current direction:** The buyer uses the protected browser console; WhatsApp has been dropped. See [README.md](README.md) for the current E2E flow. Original WhatsApp-specific steps below are superseded.

Revised planning artifact. No bot has been deployed and no calls or messages have been sent.

## The story

“I send Sauda a product link on WhatsApp. Its research agent identifies the product and finds sellers. I say 'Call them all.' Its negotiation agent calls them in Hindi or English, negotiates across real quotes, and returns the best offer. I can listen to the calls without leaving WhatsApp.”

The viewer should see a normal WhatsApp conversation, not a separate buyer dashboard. A private developer console may help explain evidence or diagnose a problem, but it is not part of the buyer journey.

## What must actually happen

> Buyer message → live product research → sourced seller shortlist → buyer authorization → real seller calls → comparable quotes → real negotiation callback → final WhatsApp offer → actual call audio returned in WhatsApp.

A clickable listing, a ringing phone, a price card, or a WhatsApp notification on its own is insufficient. The complete sequence must connect the buyer's request to a real seller response.

## Prepare real participants

- Let the buyer choose a real product they have an interest in purchasing. Do not hard-code the product in the research agent.
- Rehearse with three relevant sellers who actually carry it. Agree on an available time for recorded AI calls.
- Do not script seller prices, concessions or responses, and do not imply that a purchase is guaranteed.
- If the research agent finds different sellers during the demo, show the actual list. Do not silently substitute prearranged numbers behind unrelated business names.
- Keep a backup real seller if useful, but disclose any manual addition and have it included in the authorized list.
- Match the demonstration to Indian business hours and the sellers' availability.
- The buyer may interact in Hindi or English; let actual seller speech determine voice language switching.

A planned product and participant availability make the demo practical. A seeded seller list presented as live autonomous research would make the research claim false.

## First milestone: prove the channel

Before spending time on prompts, confirm all of these with the actual accounts:

| Check | Required evidence |
| --- | --- |
| Incoming WhatsApp | Buyer sends text to the bot and the backend receives it |
| Outgoing WhatsApp | Bot sends a dynamic response to that same buyer |
| Audio delivery | Bot sends an actual playable audio attachment to the chat |
| Seller call | Bolna calls a real Indian number through the configured account |
| Recording | A completed test call yields a recording that the server saves |
| Evidence retrieval | That saved recording can be sent back into WhatsApp |
| Discovery | Search retrieves real product/seller sources and attributable phone information |
| Persistence | Restarting the server does not lose the conversation, audio or completed work |

Bolna trial accounts may restrict dialing to verified numbers. WhatsApp test senders/recipients and business senders have their own setup requirements. A Bolna/AiSensy outbound template alone does not prove the inbound and media features needed for this bot.

Use the chosen WhatsApp Business channel consistently. Keep the demo inside its customer-service window; test a suitable approved template separately if a job may finish outside it.

## Full demo: allow about 12–18 minutes

Research and seller timing are variable. These are estimates, not an automatic countdown to a guaranteed result.

| Approximate time | Buyer/agent action | Evidence |
| --- | --- | --- |
| 0:00–0:30 | Buyer sends product link or description, with quantity/PIN if known | Original WhatsApp request |
| 0:30–2:30 | Research agent resolves the variant, searches sellers and replies | Actual product links and a sourced callable shortlist |
| 2:30–3:00 | Buyer replies “Call them all” | One authorization for the displayed list and follow-ups |
| 3:00–8:00 | Bolna completes first-round calls | Real execution records, seller-confirmed terms |
| 8:00–9:00 | Backend validates and compares | Matching quantity/specs, GST/shipping included correctly |
| 9:00–13:00 | Negotiation agent calls eligible sellers back | Another seller's genuine comparable quote is used |
| 13:00–15:00 | Bot sends the final offer | Seller contact, terms, validity, source link and next step |
| 15:00–16:00 | Buyer requests “Play Seller B's call” | Actual audio plays in WhatsApp |
| Remaining buffer | Show comparison, transcript or a correction | Stored evidence and buyer control |

The buyer should need only the initial request and “Call them all” for the core journey when essential intent is already present. An evidence request is optional. If clarification is necessary, show one focused question rather than hiding it.

## Short stage version: 4–6 minutes

If the slot is too short for full research and six phone conversations:

1. Show the original WhatsApp request, researched shortlist and buyer authorization from an earlier real run. Make its timestamp visible.
2. Explain: “These first-round calls happened earlier today; this next callback is live.”
3. Let an already authorized pending callback run live, or have the buyer explicitly request one additional callback in WhatsApp if the earlier campaign is complete. Respect the call limits.
4. Show the seller response and final comparison. An unchanged price or refusal is a legitimate outcome.
5. Show the final recommendation arriving in the same WhatsApp chat.
6. Type “recording” and play the actual callback audio in WhatsApp.
7. If time remains, ask “Why this seller?” to demonstrate an evidence-backed explanation.

Do not replay a finished campaign's jobs merely to make a stage animation look live. Preserve the distinction between earlier evidence and new external actions.

## Desired moments

- The research agent identifies a colour/model from the supplied link without asking the buyer to repeat it.
- The bot finds a supplier's attributable number through another public source when a marketplace masks it.
- One “Call them all” triggers the whole approved negotiation sequence.
- A seller switches Hindi/English and the agent preserves context.
- The agent catches a per-pack price or “GST extra” detail.
- A callback references a real competing quote.
- The buyer receives the final offer and plays its supporting recording inside WhatsApp.

These are desired observations, not a script that sellers must follow.

## Recovery rules

| Failure | Honest response |
| --- | --- |
| Product link is inaccessible | Research public alternatives using identifiers; ask for the model only if still unresolved |
| Critical variant is ambiguous | Ask one short product-choice question while other research continues |
| Seller number cannot be attributed | Exclude it from callable results; do not fabricate or silently substitute a number |
| Seller does not answer | Apply the bounded retry policy or report unreachable |
| Seller will not negotiate | Keep the unchanged quote; do not manufacture a discount |
| Cheaper quote is a different product | Exclude it from the exact-match benchmark |
| No comparable alternative exists | Ask for best terms without inventing a competing price |
| Callback is not welcome | Do not call that seller again |
| Quote extraction is wrong | Save the correction and recompute affected comparison/actions |
| Recording is still processing | Say so; send it once available |
| WhatsApp final message fails | Persist and report/retry according to the actual error; do not mark delivered |
| Buyer says stop | Cancel future work and explain any already connected call |
| Live call fails on stage | Play a clearly labelled earlier real recording |
| No quote meets a supplied budget | Report no eligible result and show the nearest alternatives |
| Seller provides payment instructions | Attribute them to the seller; do not claim the bot verified payment or completed a purchase |

## Evidence to retain

Save the buyer's source message, research source URLs and timestamps, brief/list versions, “Call them all” message ID, actual authorized seller set, Bolna execution IDs, original recordings/transcripts, quote revisions, benchmark used for each callback, final result and WhatsApp delivery evidence.

Keep real and simulated development data separate. A test transcript helps validate extraction, but only actual seller calls support the demo's claim of real negotiation.

## Submission assets

The official form requests a project description, a submission link, and a pitch deck/video link. Use the repository and a clear WhatsApp demo video; a buyer-facing website is unnecessary.

Suggested five-slide pitch:

1. Problem: buying requires manual product research and several seller phone conversations.
2. Experience: send a link, say “Call them all,” receive a ready-to-act-on offer.
3. Two agents: research discovers the sellers; negotiation calls and compares them.
4. Evidence: real product sources, first quote, callback, final offer and audio in WhatsApp.
5. What is proven: one buyer, Indian sellers, Hindi/English, real negotiation and recorded evidence; broader coverage and payments remain outside the demo.

Video edits can shorten waiting and ringing, with time skips labelled. Keep the full recordings. Do not claim every seller in India was searched or that a quote means the purchase has closed.

## Completion criteria

The buyer stays in WhatsApp. Research identifies a buyer-chosen product and at least two actual callable sellers. One authorization starts real calls and at least one real cross-seller negotiation callback. The final seller details and offer arrive in that same chat. A recording request returns playable audio from the server's persisted copy.

The preferred demo uses three sellers and exercises both Hindi and English. A price reduction is welcome but not guaranteed; truthful comparison and negotiation outcomes are required.
