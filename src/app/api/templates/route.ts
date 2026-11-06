import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth/current-user";
import { getUserDb } from "@/lib/db/client";
import { findConversationInbox, findInboxId } from "@/lib/db/repos/messaging";
import { listWhatsAppTemplates } from "@/lib/ycloud/client";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";

export async function GET(request: Request) {
  const supabase = await getUserDb();
  const userId = await getCurrentUserId();
  const user = userId ? { id: userId } : null;
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const inboxId = url.searchParams.get("inboxId");
  const conversationId = url.searchParams.get("conversationId");

  let resolvedInboxId = inboxId;
  if (!resolvedInboxId && conversationId) {
    const { data: conversation } = await findConversationInbox(
      supabase,
      conversationId,
    );
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
  const { data: inbox } = await findInboxId(supabase, resolvedInboxId);
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
