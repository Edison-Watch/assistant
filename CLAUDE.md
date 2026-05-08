# Chat SDK Slack Bot

Slack bot using [chat-sdk](https://chat-sdk.dev) with `@chat-adapter/slack` (webhook mode) and `@chat-adapter/state-redis`.

- Runtime: Bun (auto-loads `.env`, no dotenv needed)
- HTTP server: `Bun.serve()` on port 3123
- State: local Redis on `localhost:6379`
- Slack setup and known issues: `docs/SLACK_INTEGRATION.md`
