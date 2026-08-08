import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyYCloudSignature } from "@/lib/ycloud/signature";

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

  return NextResponse.json({ received: true, result: data });
}
