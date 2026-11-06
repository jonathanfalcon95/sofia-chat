import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { listConversationMessagesPage } from "@/lib/db/repos/messages";
import { getSessionUserId } from "@/lib/rbac/session";

/** One page of a thread, newest first. `before` is a created_at passed through untouched. */
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

  const db = await getUserDb();
  const { data, error } = await listConversationMessagesPage(
    db,
    conversationId,
    params.get("before"),
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ messages: data ?? [] });
}
