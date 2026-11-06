import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  countPendingWebhooks,
  markWebhookProcessed,
  readCapturedWebhooks,
} from "@/lib/ycloud/webhook-capture";
import { processCapturedWebhook } from "@/lib/ycloud/webhook-handler";

export const runtime = "nodejs";
export const maxDuration = 120;

const BATCH = 100;

function authorized(request: Request) {
  const expected = process.env.WEBHOOK_DRAIN_TOKEN;
  if (!expected) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * Processes captured webhooks in arrival order, on whichever database is active. Stops at the
 * first failure so order is kept; running it again resumes there, and repeats are deduplicated by
 * event id. Absent unless a token is configured.
 */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let processed = 0;
  for (const webhook of await readCapturedWebhooks(BATCH)) {
    const response = await processCapturedWebhook(webhook);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return NextResponse.json(
        {
          processed,
          stoppedAt: webhook.id,
          status: response.status,
          error: body?.error ?? null,
          pending: await countPendingWebhooks(),
        },
        { status: 500 },
      );
    }
    await markWebhookProcessed(webhook.id);
    processed += 1;
  }
  return NextResponse.json({ processed, pending: await countPendingWebhooks() });
}
