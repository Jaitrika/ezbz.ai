# ezbz.ai

Minimal web console for a single buyer to research products and run real supplier calls. The browser UI replaces the WhatsApp interface. OpenAI Responses API handles product research and quote extraction; Bolna handles live calls, call recordings, and transcripts. SQLite and a local persistent directory store campaigns and call artifacts.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run build
npm run dev
```

Open `http://localhost:3000`. Set the local values in `.env` first. This hackathon dashboard has no login or access-key gate; anyone who can reach it can view the demo and authorize real outbound calls. Keep it on a trusted network and stop the public tunnel when finished.

## Required settings

- `BOLNA_OPEN_AI_HACK_KEY` or `OPENAI_API_KEY`: key used by the app for product research and post-call quote extraction.
- `OPENAI_MODEL`: currently `gpt-6-luna`, which supports Responses API web search.
- `BOLNA_API_KEY` and `BOLNA_AGENT_ID`: authorize outbound calls through the configured Bolna agent.
- `BOLNA_FROM_NUMBER`: optional caller ID if required by the Bolna account.
- `BOLNA_TOOL_SECRET`: shared secret required by the app's Bolna custom-tool endpoints. Configure Bolna to send it as `x-tool-secret` or in the request body.
- `BOLNA_WEBHOOK_SECRET`: optional shared secret, if the Bolna webhook can send the configured value as `x-bolna-secret` or `secret`.
- `PUBLIC_BASE_URL`: public HTTPS base URL for Bolna webhooks and custom tools. A temporary tunnel URL works for local E2E testing.
- `DATA_DIR`: persistent directory for SQLite and audio; defaults to `./data`.

The app exposes `POST /webhooks/bolna` and `POST /bolna/tools/<tool-name>`. Configure the webhook and four tools (`get_negotiation_brief`, `capture_quote`, `next_negotiation_move`, `record_followup`) in the Bolna agent. See `prompts/negotiator-en.md` and `prompts/bolna-tools.json`.

## Buyer flow

1. Chat naturally in one box: describe the product, paste links, and include seller names and numbers in the same message. The OpenAI intake prompt turns explicit contacts into structured JSON; up to 10 Indian numbers are accepted.
2. Review the product brief and seller shortlist. Buyer-supplied numbers are labeled as such and are not independently verified. If no numbers are supplied, the app researches sellers on the web.
3. Click **Call all ready sellers**. This is the explicit authorization for real outbound calls.
4. Watch call statuses, review extracted offers and transcripts, and play recordings saved on the server.
5. Use the chat box for `status`, `stop`, `resume`, `compare`, `transcript`, `recording`, seller exclusion, and quote correction commands.

The demo supports one active buyer/campaign. No call is placed by opening the page or researching a product. A listing or phone number returned by web search is not independently guaranteed; check the seller evidence before authorizing calls. Quotes are seller statements, not purchase commitments.

## Server routes

- `GET /health`
- `GET /` — buyer console
- `GET /api/state`, `POST /api/messages`, `GET /api/recordings/:callId` — demo endpoints without authentication
- `POST /webhooks/bolna`
- `POST /bolna/tools/:name`

The backend currently uses OpenAI web search for discovery; it does not use IndiaMART or Justdial APIs. Provider calls, webhook payload mapping, Hindi/English behavior, and actual recording formats still need live integration testing with the configured accounts.
