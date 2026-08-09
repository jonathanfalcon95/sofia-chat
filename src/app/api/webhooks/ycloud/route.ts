import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyYCloudSignature } from "@/lib/ycloud/signature";
import { extractInboundMedia } from "@/lib/media";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("ycloud-signature");
  const secret = process.env.YCLOUD_WEBHOOK_SECRET ?? "";

  if (!verifyYCloudSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: {
    id?: string;
    type?: string;
    [key: string]: unknown;
  };

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventId = payload.id;
  const eventType = payload.type;
  if (!eventId || !eventType) {
    return NextResponse.json({ error: "missing_event_fields" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );

  const { data, error } = await supabase.rpc("process_ycloud_webhook", {
    p_secret: secret,
    p_event_id: eventId,
    p_event_type: eventType,
    p_payload: payload,
  });

  if (error) {
    console.error("webhook rpc error", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich inbound media fields (link/mime/filename) that older RPC paths omit.
  if (
    eventType === "whatsapp.inbound_message.received" ||
    eventType === "whatsapp.inbound.message"
  ) {
    const msg = (payload.whatsappInboundMessage ||
      payload.whatsappMessage) as Record<string, unknown> | undefined;
    if (msg) {
      const media = extractInboundMedia(msg);
      const ids = [msg.id, msg.wamid]
        .map((v) => (v == null ? "" : String(v)))
        .filter(Boolean);
      if (media?.mediaUrl && ids.length > 0) {
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
        }
      }
    }
  }

  return NextResponse.json({ received: true, result: data });
}
