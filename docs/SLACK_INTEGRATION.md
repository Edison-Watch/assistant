# Slack Integration

Slack bot built with [chat-sdk](https://chat-sdk.dev/docs/getting-started) using the `@chat-adapter/slack` webhook adapter.

## Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) with the manifest in [Slack adapter docs](https://chat-sdk.dev/docs/adapters/slack).
2. Copy credentials into `.env` (see `.env.example`).
3. Run a local Redis instance (`brew services start redis`).
4. Start the bot: `bun run index.ts`.
5. Expose the webhook via ngrok: `ngrok http 3123`.
6. Set the ngrok URL as the Request URL in **Event Subscriptions** and **Interactivity**: `https://<id>.ngrok-free.app/api/webhooks/slack`.

## Required bot token scopes

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive `app_mention` events |
| `channels:history` | Read messages in public channels |
| `channels:read` | List and get info about public channels |
| `chat:write` | Post messages |
| `groups:history` | Read messages in private channels |
| `groups:read` | List and get info about private channels |
| `im:history` | Read DM messages |
| `im:read` | List and get info about DMs |
| `mpim:history` | Read group DM messages |
| `mpim:read` | List and get info about group DMs |
| `reactions:read` | Read emoji reactions |
| `reactions:write` | Add emoji reactions |
| `users:read` | Resolve user IDs to display names (required for `msg.author.fullName`) |

Without `users:read`, the SDK silently falls back to raw user IDs (e.g. `U05T70SLY30`) instead of human-readable names. After adding a scope, **reinstall the app** to the workspace for it to take effect.

## Known issues

### Socket Mode is not supported in `@chat-adapter/slack@4.26.0`

The [chat-sdk docs](https://chat-sdk.dev/docs/adapters/slack) describe a `mode: "socket"` config option with `appToken` support, but as of v4.26.0 these fields do not exist in the published package — zero references to "socket" or "WebSocket" in the compiled output.

**If Socket Mode is enabled on the Slack app, no events will be delivered.** Slack routes events over WebSocket when Socket Mode is on, bypassing the HTTP webhook entirely. The symptom is: URL verification succeeds (challenge response works), but no `app_mention` or `message.*` events arrive.

**Fix:** Disable Socket Mode in the Slack app settings (Settings > Socket Mode > toggle OFF). Events will then be delivered to the webhook URL via HTTP.

### ngrok URL changes on restart

The free ngrok URL is ephemeral. After restarting ngrok, update the Request URL in both **Event Subscriptions** and **Interactivity & Shortcuts** in the Slack app config.

### Reinstall after changing event subscriptions

After adding or removing bot events, Slack may require you to **reinstall the app** to the workspace (OAuth & Permissions > Reinstall to Workspace) before the new events are delivered.
