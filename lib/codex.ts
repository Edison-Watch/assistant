const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDERR_CHARS = 2000;
/** How long to wait for stderr to finish draining before reporting a failure. */
const STDERR_GRACE_MS = 5000;
/** How long to keep reading stdout after codex exits, to collect buffered output. */
const POST_EXIT_DRAIN_MS = 1000;

export type StreamCodexOptions = {
  /** Wall-clock budget for the whole run; the process is killed when it elapses. */
  timeoutMs?: number;
  /**
   * Working directory for the codex process. Defaults to this process's cwd —
   * i.e. the repo — which is what the Slack path wants. Callers whose prompt
   * carries untrusted text should point this at a directory with nothing in it.
   */
  cwd?: string;
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
const DRAIN_OVER = Symbol("drain-over");
const EXITED = Symbol("exited");

export async function* streamCodex(
  prompt: string,
  opts: StreamCodexOptions = {},
): AsyncIterable<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Explicit rather than truthy: cwd is an isolation boundary, and a caller that
  // computes an empty path should fail loudly instead of silently getting the repo.
  if (opts.cwd !== undefined && opts.cwd.trim() === "") {
    throw new Error("streamCodex: cwd was set to an empty path");
  }

  const proc = Bun.spawn(
    ["codex", "exec", "--ephemeral", "-s", "read-only", "--json", "-"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    },
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

  // Once codex has exited, everything it will ever emit is already sitting in
  // the pipe buffer. Waiting for EOF instead would hang whenever a descendant
  // inherited stdout and outlives it.
  let exited = false;
  const exitSeen = proc.exited.then(() => {
    exited = true;
    return EXITED;
  });

  const stdoutReader = proc.stdout.getReader();

  try {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageCount = 0;
    let pendingRead: ReturnType<typeof stdoutReader.read> | null = null;

    while (true) {
      pendingRead ??= stdoutReader.read();
      // The post-exit grace is armed fresh for each read, so it measures only
      // time spent waiting on the pipe. Arming it once at exit would let a slow
      // Slack consumer burn the window while suspended at a yield below, and a
      // still-draining pipe would look empty.
      const result = await Promise.race([
        pendingRead,
        timeoutFired,
        exited ? Bun.sleep(POST_EXIT_DRAIN_MS).then(() => DRAIN_OVER) : exitSeen,
      ]);
      if (result === EXITED) continue; // re-race with the grace armed
      // Either remaining sentinel ends the loop; `timedOut` distinguishes below.
      if (typeof result === "symbol") break;
      pendingRead = null;
      if (result.done) break;

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

    // The kill may have landed after stdout closed rather than during the read.
    if (timedOut) {
      throw new Error(
        `codex timed out after ${timeoutMs}ms${stderrDetail(stderrTail)}`,
      );
    }

    if (exitCode !== 0) {
      // Only the failure path needs stderr, and the wait for it must be bounded:
      // a descendant can hold the pipe open after codex itself has exited.
      await Promise.race([
        stderrDrained,
        timeoutFired,
        Bun.sleep(STDERR_GRACE_MS),
      ]);
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
