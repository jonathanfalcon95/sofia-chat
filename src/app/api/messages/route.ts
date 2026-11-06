import { NextResponse } from "next/server";
import { decodePageCursor } from "@/lib/conversations/page-cursor";
import { getUserDb } from "@/lib/db/client";
import { listConversationMessagesPage } from "@/lib/db/repos/messages";
import { getSessionUserId } from "@/lib/rbac/session";

/** One page of a thread, newest first. `before` is an opaque page cursor. */
export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const conversationId = params.get("conversationId") ?? "";
  if (!conversationId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const beforeParam = params.get("before");
  const before = beforeParam ? decodePageCursor(beforeParam) : null;
  if (beforeParam && !before) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  const db = await getUserDb();
  const { data, error } = await listConversationMessagesPage(
    db,
    conversationId,
    before,
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ messages: data ?? [] });
}
