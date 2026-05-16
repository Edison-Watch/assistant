import { Chat, toAiMessages } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { streamCodex } from "./lib/codex";
import { granolaWebhook } from "./webhooks/granola";
import type { WebhookRoute } from "./webhooks/types";

const slackAdapter = createSlackAdapter();

const bot = new Chat({
  userName: "edison-bot",
  adapters: {
    slack: slackAdapter,
  },
  state: createRedisState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.startTyping();

  const result = await thread.adapter.fetchMessages(thread.id, { limit: 20 });
  const history = await toAiMessages(result.messages, { includeNames: true });

  const prompt = history
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n");

  await thread.post(streamCodex(prompt));
});

await bot.initialize();

const webhooks: WebhookRoute[] = [granolaWebhook({ bot })];

const port = 3123;

Bun.serve({
  port,
  routes: {
    "/api/webhooks/slack": {
      POST: async (req) => {
        return slackAdapter.handleWebhook(req);
      },
    },
    ...Object.fromEntries(webhooks.map((w) => [w.path, { POST: w.handler }])),
  },
  fetch(req) {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Bot is running on http://localhost:${port}`);
console.log(`  POST /api/webhooks/slack`);
for (const w of webhooks) console.log(`  POST ${w.path}`);
