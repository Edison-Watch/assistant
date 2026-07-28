const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_CHARS = 2000;

export type StreamCodexOptions = {
  /** Wall-clock budget for the whole run; the process is killed when it elapses. */
  timeoutMs?: number;
};

/** Text of an agent message event, or null if this line isn't one. */
function agentMessageText(line: string): string | null {
  try {
    const event = JSON.parse(line);
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      event.item.text
    ) {
      return String(event.item.text);
    }
  } catch {}
  return null;
}

function stderrDetail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? `: ${trimmed}` : "";
}

const TIMED_OUT = Symbol("timed-out");

export async function* streamCodex(
  prompt: string,
  opts: StreamCodexOptions = {},
): AsyncIterable<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const proc = Bun.spawn(
    ["codex", "exec", "--ephemeral", "-s", "read-only", "--json", "-"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Keep the tail of stderr so a failure carries an actual diagnostic instead of
  // just an exit code.
  let stderrTail = "";
  const stderrReader = proc.stderr.getReader();
  const stderrDrained = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(
        -MAX_STDERR_CHARS,
      );
    }
  })().catch(() => {});

  let timedOut = false;
  let fireTimeout: () => void = () => {};
  const timeoutFired = new Promise<typeof TIMED_OUT>((resolve) => {
    fireTimeout = () => resolve(TIMED_OUT);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // Killing codex is not enough to end the read: a grandchild can hold the
    // pipe open, so unblock the loop explicitly.
    fireTimeout();
  }, timeoutMs);

  const stdoutReader = proc.stdout.getReader();

  try {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageCount = 0;

    while (true) {
      const result = await Promise.race([stdoutReader.read(), timeoutFired]);
      if (result === TIMED_OUT || result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const text = agentMessageText(line);
        if (text === null) continue;
        if (messageCount > 0) yield "\n\n---\n\n";
        yield text;
        messageCount++;
      }
    }

    if (timedOut) {
      throw new Error(
        `codex timed out after ${timeoutMs}ms${stderrDetail(stderrTail)}`,
      );
    }

    if (buffer.trim()) {
      const text = agentMessageText(buffer);
      if (text !== null) {
        if (messageCount > 0) yield "\n\n---\n\n";
        yield text;
        messageCount++;
      }
    }

    const exitCode = await proc.exited;
    await stderrDrained;

    if (exitCode !== 0) {
      throw new Error(
        `codex exited with code ${exitCode}${stderrDetail(stderrTail)}`,
      );
    }
  } finally {
    clearTimeout(timer);
    // No-ops once it has exited; prevents an orphaned child and dangling reads
    // if the consumer abandons the stream early.
    proc.kill();
    stdoutReader.cancel().catch(() => {});
    stderrReader.cancel().catch(() => {});
  }
}
