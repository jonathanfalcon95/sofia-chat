import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyYCloudSignature } from "@/lib/ycloud/signature";
import { extractInboundMedia } from "@/lib/media";
import { logSystemError } from "@/lib/errors/log-system-error";
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
  supabase: ReturnType<typeof createAdminClient>,
  eventType: string,
  payload: Record<string, unknown>,
  eventId: string,
) {
  if (
    eventType !== "whatsapp.inbound_message.received" &&
    eventType !== "whatsapp.inbound.message"
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
  const { error: mediaError } = await supabase
    .from("messages")
    .update({
      type: media.type,
      body: media.body,
      media_url: media.mediaUrl,
      media_mime: media.mediaMime,
      media_filename: media.mediaFilename,
      media_sha256: media.mediaSha256,
    })
    .in("ycloud_message_id", ids);
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

export async function processVerifiedYCloudEvent(args: {
  rawBody: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  accountId?: string | null;
  legacySecret?: string;
}) {
  const supabase = createAdminClient();
  if (args.accountId) {
    const { data, error } = await supabase.rpc(
      "process_ycloud_webhook_for_account",
      {
        p_account_id: args.accountId,
        p_event_id: args.eventId,
        p_event_type: args.eventType,
        p_payload: args.payload,
      },
    );
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
    return NextResponse.json({ received: true, result: data });
  }

  const secret = args.legacySecret ?? process.env.YCLOUD_WEBHOOK_SECRET ?? "";
  const { data, error } = await supabase.rpc("process_ycloud_webhook", {
    p_secret: secret,
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_payload: args.payload,
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
  return NextResponse.json({ received: true, result: data });
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
    return processVerifiedYCloudEvent({
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

  return processVerifiedYCloudEvent({
    rawBody,
    eventId,
    eventType,
    payload,
    accountId: match.accountId,
    legacySecret: match.accountId ? undefined : match.secret,
  });
}

