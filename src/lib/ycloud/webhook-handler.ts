import { after, NextResponse } from "next/server";
import { getSystemDb } from "@/lib/db/client";
import { updateMessagesMediaByYCloudIds } from "@/lib/db/repos/messaging";
import {
  processYCloudWebhook,
  processYCloudWebhookForAccount,
} from "@/lib/db/repos/ycloud";
import type { Db } from "@/lib/db/types";
import { verifyYCloudSignature } from "@/lib/ycloud/signature";
import { extractInboundMedia } from "@/lib/media";
import { logSystemError } from "@/lib/errors/log-system-error";
import { enrichMessageTextFromWebhook } from "@/lib/ycloud/message-enrichment";
import {
  captureWebhook,
  isWebhookCaptureOn,
  type CapturedWebhook,
} from "@/lib/ycloud/webhook-capture";
import {
  decryptAccountWebhookSecret,
  listYCloudAccountRows,
  type YCloudAccountRow,
} from "@/lib/ycloud/accounts";

function parsePayload(rawBody: string) {
  let payload: {
    id?: string;
    type?: string;
    [key: string]: unknown;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { error: NextResponse.json({ error: "invalid_json" }, { status: 400 }) };
  }
  const eventId = payload.id;
  const eventType = payload.type;
  if (!eventId || !eventType) {
    return {
      error: NextResponse.json({ error: "missing_event_fields" }, { status: 400 }),
    };
  }
  return { payload, eventId, eventType };
}

async function enrichInboundMedia(
  supabase: Db,
  eventType: string,
  payload: Record<string, unknown>,
  eventId: string,
) {
  if (
    eventType !== "whatsapp.inbound_message.received" &&
    eventType !== "whatsapp.inbound.message" &&
    eventType !== "whatsapp.message.updated" &&
    eventType !== "whatsapp.smb.message.echoes" &&
    eventType !== "whatsapp.smb.message.created"
  ) {
    return;
  }
  const msg = (payload.whatsappInboundMessage ||
    payload.whatsappMessage) as Record<string, unknown> | undefined;
  if (!msg) return;
  const media = extractInboundMedia(msg);
  const ids = [msg.id, msg.wamid]
    .map((v) => (v == null ? "" : String(v)))
    .filter(Boolean);
  if (!media?.mediaUrl || ids.length === 0) return;
  const { error: mediaError } = await updateMessagesMediaByYCloudIds(
    supabase,
    ids,
    {
      type: media.type,
      body: media.body,
      media_url: media.mediaUrl,
      media_mime: media.mediaMime,
      media_filename: media.mediaFilename,
      media_sha256: media.mediaSha256,
    },
  );
  if (mediaError) {
    console.error("webhook media enrich error", mediaError);
    await logSystemError({
      source: "api.webhooks.ycloud",
      message: "inbound media enrich failed",
      error: mediaError,
      level: "warn",
      errorCode: "webhook_media_enrich_error",
      context: { eventId, eventType, messageIds: ids },
    });
  }
}

function scheduleTextEnrichment(
  eventType: string,
  payload: Record<string, unknown>,
  eventId: string,
) {
  after(async () => {
    try {
      await enrichMessageTextFromWebhook(payload);
    } catch (error) {
      console.error("webhook text enrich error", error);
      await logSystemError({
        source: "api.webhooks.ycloud",
        message: "message text enrich failed",
        error,
        level: "warn",
        errorCode: "webhook_text_enrich_error",
        context: { eventId, eventType },
      });
    }
  });
}

export async function processVerifiedYCloudEvent(args: {
  rawBody: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  accountId?: string | null;
  legacySecret?: string;
}) {
  const supabase = getSystemDb();
  if (args.accountId) {
    const { data, error } = await processYCloudWebhookForAccount(supabase, {
      accountId: args.accountId,
      eventId: args.eventId,
      eventType: args.eventType,
      payload: args.payload,
    });
    if (error) {
      console.error("webhook rpc error", error);
      await logSystemError({
        source: "api.webhooks.ycloud",
        message: "process_ycloud_webhook_for_account failed",
        error,
        httpStatus: 500,
        errorCode: "webhook_rpc_error",
        context: { eventId: args.eventId, eventType: args.eventType, accountId: args.accountId },
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await enrichInboundMedia(supabase, args.eventType, args.payload, args.eventId);
    scheduleTextEnrichment(args.eventType, args.payload, args.eventId);
    return NextResponse.json({ received: true, result: data });
  }

  const secret = args.legacySecret ?? process.env.YCLOUD_WEBHOOK_SECRET ?? "";
  const { data, error } = await processYCloudWebhook(supabase, {
    secret,
    eventId: args.eventId,
    eventType: args.eventType,
    payload: args.payload,
  });
  if (error) {
    console.error("webhook rpc error", error);
    await logSystemError({
      source: "api.webhooks.ycloud",
      message: "process_ycloud_webhook failed",
      error,
      httpStatus: 500,
      errorCode: "webhook_rpc_error",
      context: { eventId: args.eventId, eventType: args.eventType },
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  await enrichInboundMedia(supabase, args.eventType, args.payload, args.eventId);
  scheduleTextEnrichment(args.eventType, args.payload, args.eventId);
  return NextResponse.json({ received: true, result: data });
}

/** Processes the event, or stores it for later while the database is being switched. */
async function acceptVerifiedEvent(args: Parameters<typeof processVerifiedYCloudEvent>[0]) {
  if (!isWebhookCaptureOn()) return processVerifiedYCloudEvent(args);
  await captureWebhook(args.accountId, args.rawBody);
  return NextResponse.json({ received: true, captured: true });
}

/** Handles a captured event whose signature was checked when it arrived. */
export async function processCapturedWebhook(webhook: CapturedWebhook) {
  const parsed = parsePayload(webhook.rawBody);
  if ("error" in parsed && parsed.error) return parsed.error;
  const { payload, eventId, eventType } = parsed as {
    payload: Record<string, unknown>;
    eventId: string;
    eventType: string;
  };
  return processVerifiedYCloudEvent({
    rawBody: webhook.rawBody,
    eventId,
    eventType,
    payload,
    accountId: webhook.accountId,
  });
}

export async function handleYCloudWebhookRequest(
  request: Request,
  accountId?: string,
) {
  const rawBody = await request.text();
  const signature = request.headers.get("ycloud-signature");
  const parsed = parsePayload(rawBody);
  if ("error" in parsed && parsed.error) return parsed.error;
  const { payload, eventId, eventType } = parsed as {
    payload: Record<string, unknown>;
    eventId: string;
    eventType: string;
  };

  if (accountId) {
    let row: YCloudAccountRow;
    try {
      const rows = await listYCloudAccountRows();
      const found = rows.find((r) => r.id === accountId && r.is_active);
      if (!found) {
        return NextResponse.json({ error: "unknown_account" }, { status: 404 });
      }
      row = found;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "account_lookup_failed" },
        { status: 500 },
      );
    }
    const secret = decryptAccountWebhookSecret(row);
    if (!secret || !verifyYCloudSignature(rawBody, signature, secret)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    return acceptVerifiedEvent({
      rawBody,
      eventId,
      eventType,
      payload,
      accountId,
    });
  }

  const candidates: Array<{ secret: string; accountId: string | null }> = [];
  const envSecret = process.env.YCLOUD_WEBHOOK_SECRET?.trim();
  if (envSecret) candidates.push({ secret: envSecret, accountId: null });
  try {
    const rows = await listYCloudAccountRows();
    for (const row of rows) {
      if (!row.is_active) continue;
      const secret = decryptAccountWebhookSecret(row);
      if (secret) candidates.push({ secret, accountId: row.id });
    }
  } catch {
    // Legacy env-only path still works if DB lookup fails.
  }

  const match = candidates.find((c) =>
    verifyYCloudSignature(rawBody, signature, c.secret),
  );
  if (!match) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  return acceptVerifiedEvent({
    rawBody,
    eventId,
    eventType,
    payload,
    accountId: match.accountId,
    legacySecret: match.accountId ? undefined : match.secret,
  });
}

