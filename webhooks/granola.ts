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

const DEDUP_TTL_SECONDS = 60 * 60 * 24 * 7;

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

      let payload: GranolaPayload;
      try {
        payload = (await req.json()) as GranolaPayload;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!payload.meeting_id || !payload.title || !payload.transcript) {
        return new Response("Missing required fields: meeting_id, title, transcript", { status: 400 });
      }

      const dedupKey = `webhook:granola:${payload.meeting_id}`;
      const claimed = await redis.send("SET", [dedupKey, "1", "NX", "EX", String(DEDUP_TTL_SECONDS)]);
      if (claimed !== "OK") {
        return new Response("Duplicate (already processed)", { status: 200 });
      }

      void processGranolaMeeting(ctx, channelId, payload);

      return new Response("OK", { status: 200 });
    },
  };
}

async function processGranolaMeeting(
  ctx: WebhookContext,
  channelId: string,
  payload: GranolaPayload,
) {
  const channel = ctx.bot.channel(`slack:${channelId}`);
  const attendeesLine = payload.attendees?.length
    ? `\nAttendees: ${payload.attendees.join(", ")}`
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
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await channel.post(
        `:warning: Failed to summarize meeting "${payload.title}" (\`${payload.meeting_id}\`): ${msg}`,
      );
    } catch (notifyErr) {
      console.error("[granola webhook] failure notify also failed:", notifyErr);
    }
  }
}
