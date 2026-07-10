# Deployment (macOS launchd)

The bot runs as a per-user launchd **LaunchAgent** so it auto-starts on login and
auto-restarts on crash. Template: [`deploy/com.edison.assistant-bot.plist`](../deploy/com.edison.assistant-bot.plist).

## Install

```sh
# 1. Copy the template into place and edit WorkingDirectory to your checkout.
cp deploy/com.edison.assistant-bot.plist ~/Library/LaunchAgents/

# 2. Make sure Redis is running (used for chat state + inbound-webhook dedup).
brew services start redis

# 3. Load it (bootstrap into the GUI session so it starts on login).
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.edison.assistant-bot.plist

# 4. Verify.
tail -n 20 ~/Library/Logs/assistant-bot.log   # expect "Bot is running on http://localhost:3123"
lsof -i :3123                                  # expect a bun process LISTEN
curl -i -X POST http://localhost:3123/api/webhooks/slack -d '{}'   # expect 401 (adapter reachable)
```

Env vars (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `REDIS_URL`, `WEBHOOK_SECRET`,
`GRANOLA_SLACK_CHANNEL_ID`) are auto-loaded by Bun from `.env` in `WorkingDirectory`.
**Do not put secrets in the plist.**

## Managing the agent

```sh
launchctl kickstart -k gui/$(id -u)/com.edison.assistant-bot   # restart
launchctl bootout   gui/$(id -u)/com.edison.assistant-bot      # stop + unload
launchctl list | grep assistant-bot                            # status (col 1 = PID, col 2 = last exit)
```

## Gotcha: repo on an external / non-boot volume needs Full Disk Access

If the checkout lives on an **external or removable volume** (e.g. a USB drive under
`/Volumes/...`, possibly reached via a `~/Github` symlink), macOS **TCC blocks
launchd-spawned processes from reading file *contents* there** — metadata/`ls` is
allowed, but `read()` returns `EPERM` ("Operation not permitted"). Symptoms: the agent
shows a PID but the log is empty, port 3123 never binds, and `curl` gets connection
refused. It works from an interactive terminal only because Terminal already holds the
grant.

**Fix:** grant **Full Disk Access to the bun binary**:

1. System Settings → Privacy & Security → **Full Disk Access** → **+**
2. Add `/opt/homebrew/bin/bun` (⌘⇧G to type the path), toggle it **on**.
3. Restart the agent: `launchctl kickstart -k gui/$(id -u)/com.edison.assistant-bot`

The grant is keyed to the binary, so after `brew upgrade bun` (its Cellar path/cdhash
changes) you may need to re-add it. If the volume is slow to mount at boot, the first
launch attempt exits and `KeepAlive`+`ThrottleInterval` retry every 10s until the volume
is readable — the agent self-heals.

Diagnose a suspected TCC block with a boot-volume probe script that `ls`es then `head`s a
file on the external volume from a throwaway LaunchAgent: `ls` succeeds, `head` fails with
`Operation not permitted`.

## Gotcha: codex CLI must not be on a revoked-cert build

The Granola webhook shells out to the `codex` CLI (`lib/codex.ts`). If codex hangs on
**every** invocation — even `codex --version`, stuck in `_dyld_start` before `main()` —
its signing certificate has likely been **revoked**. Check:

```sh
spctl --assess -vvv --type execute \
  "$(dirname "$(readlink -f "$(command -v codex)")")"/../lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex
# CSSMERR_TP_CERT_REVOKED  => revoked
```

**Fix:** upgrade to a build signed with a valid cert: `npm install -g @openai/codex@latest`.
(Observed: 0.129.0 was revoked and hung; 0.144.0 assesses clean and works.) Note `codex
exec` also requires running from a git repo or trusted dir — the bot satisfies this because
its `WorkingDirectory` is this repo.
