# Sauda

WhatsApp-first purchasing assistant for one buyer. The app researches a buyer-selected product, presents sourced Indian sellers, and waits for the buyer to authorize calls. Bolna handles the live calls; OpenAI handles web research and transcript quote extraction. SQLite and a local persistent directory hold the campaign, messages, transcripts, and audio.

## Start locally

Requires Node.js 22 or newer. Install dependencies with `npm install`, copy `.env.example` to `.env`, fill what is available, then run `npm run dev`. The service starts without provider credentials; provider work reports a configuration error until the corresponding credentials are supplied.

Set `PUBLIC_BASE_URL` to an HTTPS URL that can receive provider webhooks. Configure the Meta WhatsApp webhook at `/webhooks/whatsapp` for `messages`; configure the Bolna agent to call `/webhooks/bolna`. Mount `DATA_DIR` on persistent storage in deployment.

Environment values:

- `OPENAI_API_KEY`, `OPENAI_MODEL`: Responses API search and call transcript extraction.
- `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, optionally `BOLNA_FROM_NUMBER`: outbound calls. Bolna's configured agent must have Hindi and English speech, automatic language switching, recording enabled, and callback tooling enabled.
- `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION`: WhatsApp Cloud API webhooks and messages.
- `ALLOWED_BUYER_WA_ID`: optional single-buyer allowlist, digits only, including country code.
- `BOLNA_TOOL_SECRET`, `BOLNA_WEBHOOK_SECRET`: shared secrets for the tool and webhook routes. For Bolna, configure `x-tool-secret` as a custom header if supported; otherwise include `tool_secret` in the body. Configure the webhook secret as `x-bolna-secret` or `secret`.
- `DATA_DIR`: persistent SQLite and recording directory. Defaults to `./data`.

## WhatsApp journey

1. Send a public product URL or plain-language product request. Include quantity, city/PIN and delivery timing if known.
2. Sauda replies with the product summary, sellers, public sources, phone verification status, and any unresolved product questions.
3. Reply `Call them all` to authorize first-round calls to every verified seller in the displayed shortlist. Unverified contacts are never dialed.
4. Use `status`, `stop`, or `resume` to control the active campaign. Use `exclude seller [name]` before calls, `compare` for offers, `transcript [seller]` for transcripts, `correct [seller] to ₹[total]` to correct an extracted amount, and `recording` to receive the latest saved call audio.

The initial version deliberately supports one active campaign for the configured buyer. A campaign cannot place an order or make payment. Do not present a quote as comparable unless the seller and full total are confirmed. A recording request returns an actual saved provider recording; it does not synthesize replacement audio.

## Bolna agent setup

Use `prompts/negotiator-en.md` as the system prompt and configure Hindi/English automatic switching. Enable recording and final transcript/recording availability in the Bolna account. Set the webhook URL to `${PUBLIC_BASE_URL}/webhooks/bolna`. Add custom tools targeting `${PUBLIC_BASE_URL}/bolna/tools/<tool-name>`:

- `get_negotiation_brief`
- `capture_quote`
- `next_negotiation_move`
- `record_followup`

Use `prompts/bolna-tools.json` for the function names, primitive argument schemas and endpoint mapping. Verify Bolna's exact custom-function URL and auth-header configuration in the account before allowing live calls. The app binds tool calls to `app_call_id` in call context.

## Service routes

- `GET /health`
- `GET /webhooks/whatsapp`
- `POST /webhooks/whatsapp`
- `POST /webhooks/bolna`
- `POST /bolna/tools/:name`

Provider API shapes and account-specific limits need a live integration pass after credentials are available. No test calls or messages are sent automatically by starting the server.
