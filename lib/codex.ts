export async function* streamCodex(prompt: string): AsyncIterable<string> {
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
