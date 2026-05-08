import { Chat, toAiMessages } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";

const slackAdapter = createSlackAdapter();

async function* streamCodex(prompt: string): AsyncIterable<string> {
  const proc = Bun.spawn(
    ["codex", "exec", "--ephemeral", "-s", "read-only", "--json", "-"],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  proc.stdin.write(prompt);
  proc.stdin.end();

  const decoder = new TextDecoder();
  let buffer = "";
  let messageCount = 0;

  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.text
        ) {
          if (messageCount > 0) yield "\n\n---\n\n";
          yield event.item.text;
          messageCount++;
        }
      } catch {}
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.text
      ) {
        if (messageCount > 0) yield "\n\n---\n\n";
        yield event.item.text;
      }
    } catch {}
  }
}

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

const port = 3123;

Bun.serve({
  port,
  routes: {
    "/api/webhooks/slack": {
      POST: async (req) => {
        return slackAdapter.handleWebhook(req);
      },
    },
  },
  fetch(req) {
    return new Response("Not found", { status: 404 });
  },
});

console.log("Bot is running! Webhook listening on http://localhost:3123/api/webhooks/slack");
