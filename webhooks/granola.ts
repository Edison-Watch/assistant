import { redis } from "bun";
import { streamCodex } from "../lib/codex";
import type { WebhookContext, WebhookRoute } from "./types";

type GranolaPayload = {
  meeting_id: string;
  title: string;
  transcript: string;
  notes?: string;
  attendees?: string[];
};

/** How long a completed meeting stays deduped. */
const DEDUP_TTL_SECONDS = 60 * 60 * 24 * 7;
/** How long an in-flight claim is held before a retry may take over. */
const LEASE_TTL_SECONDS = 15 * 60;

// Promote/release only if this run still owns the key. A run that outlives its
// lease must not clobber the claim a retry has since taken.
const PROMOTE_IF_OWNED =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[1], 'done', 'EX', ARGV[2]) else return nil end";
const RELEASE_IF_OWNED =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export function granolaWebhook(ctx: WebhookContext): WebhookRoute {
  const channelId = process.env.GRANOLA_SLACK_CHANNEL_ID;
  const secret = process.env.WEBHOOK_SECRET;

  if (!channelId) {
    console.warn("[granola webhook] GRANOLA_SLACK_CHANNEL_ID is not set; requests will 500");
  }
  if (!secret) {
    console.warn("[granola webhook] WEBHOOK_SECRET is not set; all requests will be rejected");
  }

  return {
    path: "/api/webhooks/granola",
    handler: async (req) => {
      if (!secret || req.headers.get("x-webhook-secret") !== secret) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!channelId) {
        return new Response("GRANOLA_SLACK_CHANNEL_ID not configured", { status: 500 });
      }

      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return new Response("Invalid payload: expected a JSON object", { status: 400 });
      }
      const payload = raw as Partial<GranolaPayload>;
      if (
        typeof payload.meeting_id !== "string" ||
        typeof payload.title !== "string" ||
        typeof payload.transcript !== "string" ||
        !payload.meeting_id ||
        !payload.title ||
        !payload.transcript
      ) {
        return new Response("Missing required fields: meeting_id, title, transcript", { status: 400 });
      }

      // Claim a short lease rather than the full completion marker: if this
      // process dies mid-summary the lease expires and the sender's retry can
      // get through, instead of the meeting being silently dropped for a week.
      const dedupKey = `webhook:granola:${payload.meeting_id}`;
      const leaseValue = `processing:${crypto.randomUUID()}`;
      const claimed = await redis.send("SET", [
        dedupKey,
        leaseValue,
        "NX",
        "EX",
        String(LEASE_TTL_SECONDS),
      ]);
      if (claimed !== "OK") {
        return new Response("Duplicate (already processed)", { status: 200 });
      }

      void processGranolaMeeting(ctx, channelId, payload as GranolaPayload, dedupKey, leaseValue);

      return new Response("OK", { status: 200 });
    },
  };
}

async function processGranolaMeeting(
  ctx: WebhookContext,
  channelId: string,
  payload: GranolaPayload,
  dedupKey: string,
  leaseValue: string,
) {
  const channel = ctx.bot.channel(`slack:${channelId}`);
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const attendeesLine = attendees.length
    ? `\nAttendees: ${attendees.join(", ")}`
    : "";

  const prompt = `Write a Slack message summarizing the following meeting.

Format:
- First line: "*Meeting wrap-up — ${payload.title}*" (Slack-style bold with single asterisks).
- Then 3-5 bullets starting with "• " covering what was discussed.
- If concrete action items were mentioned, add a blank line, then "*Action items:*", then bullets starting with "• ".

No preamble, no markdown headers, no "Here is the summary" — emit only the formatted Slack message.${attendeesLine}

Transcript:
${payload.transcript}${payload.notes ? `\n\n--- Notes ---\n${payload.notes}` : ""}`;

  try {
    await channel.post(streamCodex(prompt));
  } catch (err) {
    console.error("[granola webhook] processing failed:", err);
    // Release the lease so the sender can retry. A retry after a partial post
    // can duplicate output, which is preferable to losing the summary entirely.
    try {
      await redis.send("EVAL", [RELEASE_IF_OWNED, "1", dedupKey, leaseValue]);
    } catch (delErr) {
      console.error("[granola webhook] failed to release dedup lease:", delErr);
    }
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await channel.post(
        `:warning: Failed to summarize meeting "${payload.title}" (\`${payload.meeting_id}\`): ${msg}`,
      );
    } catch (notifyErr) {
      console.error("[granola webhook] failure notify also failed:", notifyErr);
    }
    return;
  }

  // Promote the lease to a completion marker only once the summary landed.
  // A failure here is not worth alarming Slack about: the worst case is the
  // lease expiring and a later retry re-posting the summary.
  try {
    await redis.send("EVAL", [
      PROMOTE_IF_OWNED,
      "1",
      dedupKey,
      leaseValue,
      String(DEDUP_TTL_SECONDS),
    ]);
  } catch (err) {
    console.error("[granola webhook] failed to mark meeting complete:", err);
  }
}
