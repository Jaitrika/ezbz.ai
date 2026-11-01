# ezbz.ai

ezbz.ai is a buyer-side sourcing and negotiation workspace. A buyer describes a product or shares a listing, reviews the researched shortlist, then authorizes outbound calls to sellers. The app records call status, transcripts, recordings, extracted quotes, and seller quote history.

## Features

- Conversational product intake with OpenAI Responses API and web search.
- Seller discovery with product links, public source links, and evidence for extracted contact details.
- Explicit buyer approval before outbound calls through Bolna.
- Hindi and English negotiation instructions, with call transcripts and recordings stored locally.
- Quote comparison, call-again rounds, per-seller call controls, and soft deletion for chats.
- A SQLite seller directory keyed by a seller's phone number, product URL, or business name. Product records retain the latest quote and price basis; quote history records earlier prices, rounds, and changes.
- A three-column responsive web interface with chat history, call activity, seller details, and quote comparison.

## Requirements

- Node.js 22 or newer
- OpenAI API access for intake, web research, and quote extraction
- A configured Bolna agent and outbound calling account
- A public HTTPS URL for Bolna webhooks and custom tools when testing locally

## Run locally

```sh
npm install
cp .env.example .env
```

Set the required values in `.env`, then run the development UI and API:

```sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). For a production-style local run, build the frontend and start the API server:

```sh
npm run build
npm start
```

The server defaults to port `3000`. In development, Vite serves the UI on port `3000` and proxies API requests to the backend on port `3001`.

## Configuration

At least one OpenAI key and the Bolna API key and agent ID are required for the full call workflow.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API key for intake, research, and quote extraction. |
| `BOLNA_OPEN_AI_HACK_KEY` | Optional alternate key name; used if `OPENAI_API_KEY` is empty. |
| `OPENAI_MODEL` | Responses API model; defaults to `gpt-6-luna`. |
| `BOLNA_API_KEY` | Bolna API authentication. |
| `BOLNA_AGENT_ID` | Bolna outbound agent ID. |
| `BOLNA_FROM_NUMBER` | Optional configured caller ID. |
| `BOLNA_TOOL_SECRET` | Secret checked by the Bolna custom-tool endpoints. |
| `BOLNA_WEBHOOK_SECRET` | Optional webhook signature secret. |
| `PUBLIC_BASE_URL` | Public HTTPS base URL used to configure Bolna webhooks and tools. |
| `DATA_DIR` | SQLite and recording storage directory; defaults to `./data`. |
| `MAX_SELLERS` | Maximum sellers per campaign, capped at 10; defaults to 10. |
| `MAX_CONCURRENT_CALLS` | Maximum concurrent outbound calls; defaults to 2. |

Keep `.env` private and do not commit it. The example file documents the expected variable names.

## Buyer workflow

1. Describe the product or paste a product link. Seller names and Indian phone numbers can be included in the same message.
2. Review the product brief, seller shortlist, source links, and contact evidence. Web search does not guarantee a seller's identity or current availability.
3. Select **Call all sellers** to authorize outbound calls, or call a listed seller individually.
4. Review call progress, transcripts, extracted quotes, and available recordings. The buyer remains responsible for deciding whether to purchase.
5. Ask for another call round or compare the quotes from the same chat.

## Seller quote history

The backend stores seller profiles in `seller_directory`, product-specific records in `seller_products`, and individual quote records in `seller_quote_history`. A new quote updates the current product price while preserving prior quote values and the round in which each was collected. Seller matching currently uses the phone number when available, then the listing URL, then the business name.

## Bolna setup

Set `PUBLIC_BASE_URL` to the public HTTPS address that Bolna can reach, then configure these app endpoints in the Bolna agent:

- Webhook: `POST /webhooks/bolna`
- Custom tools: `POST /bolna/tools/:name`
- Tools: `get_negotiation_brief`, `capture_quote`, `next_negotiation_move`, and `record_followup`

The prompt and tool payload examples are in [`prompts/negotiator-en.md`](prompts/negotiator-en.md) and [`prompts/bolna-tools.json`](prompts/bolna-tools.json).

## API routes

- `GET /health` — service and database status.
- `GET /api/chats`, `POST /api/chats`, `DELETE /api/chats/:chatId` — chat history and soft deletion.
- `GET /api/state?chatId=<id>` — messages, sellers, calls, campaign, and quote history for a chat.
- `POST /api/messages` — submit a buyer message.
- `POST /api/chats/:chatId/sellers/:sellerId/call` — authorize a call to one seller.
- `GET /api/recordings/:callId` — stream a saved recording.
- `POST /webhooks/bolna` — Bolna call events.
- `POST /bolna/tools/:name` — Bolna agent tools.

