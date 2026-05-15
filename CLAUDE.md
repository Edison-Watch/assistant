# Chat SDK Slack Bot

Slack bot using [chat-sdk](https://chat-sdk.dev) with `@chat-adapter/slack` (webhook mode) and `@chat-adapter/state-redis`.

- Runtime: Bun (auto-loads `.env`, no dotenv needed)
- HTTP server: `Bun.serve()` on port 3123
- State: local Redis on `localhost:6379` (also used for inbound-webhook dedup via `Bun.redis`)
- Slack setup and known issues: `docs/SLACK_INTEGRATION.md`

## Inbound webhooks (custom, non-Slack)

Pluggable webhook handlers live in `webhooks/`. Each module exports a factory `(ctx: { bot }) => { path, handler }`; `index.ts` mounts them under `Bun.serve({ routes })`. Add a source by creating `webhooks/<name>.ts` and pushing the factory into the `webhooks` array in `index.ts`.

Shared conventions:
- Auth: senders must include `X-Webhook-Secret: $WEBHOOK_SECRET`.
- Dedup: handlers `SET key NX EX 604800` in Redis; duplicates return 200 without re-processing.
- Async: handlers return 200 immediately and process in the background. Failures post a `:warning:` notice to the same Slack channel.
- Codex: reuse `lib/codex.ts#streamCodex` and pipe it into `bot.channel("slack:Cxxx").post(...)` for a streamed Slack reply.

Current sources:
- `webhooks/granola.ts` — `POST /api/webhooks/granola`. Expects `{ meeting_id, title, transcript, notes?, attendees? }`. Posts a Codex summary to `GRANOLA_SLACK_CHANNEL_ID` (intended: `#edison-os-updates`).
