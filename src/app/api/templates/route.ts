import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listWhatsAppTemplates } from "@/lib/ycloud/client";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const inboxId = url.searchParams.get("inboxId");
  const conversationId = url.searchParams.get("conversationId");

  let resolvedInboxId = inboxId;
  if (!resolvedInboxId && conversationId) {
    const { data: conversation } = await supabase
      .from("conversations")
      .select("inbox_id")
      .eq("id", conversationId)
      .maybeSingle();
    resolvedInboxId = conversation?.inbox_id ?? null;
  }

  if (!resolvedInboxId) {
    return NextResponse.json(
      { error: "inbox_required", items: [] },
      { status: 400 },
    );
  }

  // Credentials load with the service role, so check access with the user's
  // client first; RLS hides inboxes the user can't reach.
  const { data: inbox } = await supabase
    .from("inboxes")
    .select("id")
    .eq("id", resolvedInboxId)
    .maybeSingle();
  if (!inbox) {
    return NextResponse.json({ error: "forbidden", items: [] }, { status: 403 });
  }

  try {
    const creds = await getInboxYCloudCredentials(resolvedInboxId);
    const data = await listWhatsAppTemplates({
      apiKey: creds.apiKey,
      limit: 100,
      wabaId: creds.wabaId || undefined,
    });
    const items = data.items ?? data.data ?? data;
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "templates_failed";
    return NextResponse.json({ error: message, items: [] }, { status: 502 });
  }
}
