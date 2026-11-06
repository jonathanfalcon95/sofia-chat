import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { fetchConversationById } from "@/lib/conversations/fetch-conversation-list";
import { getSessionUserId } from "@/lib/rbac/session";

/** `conversation` is null when there is no such row or RLS hides it. */
export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const conversationId =
    new URL(request.url).searchParams.get("conversationId") ?? "";

  try {
    const db = await getUserDb();
    const conversation = await fetchConversationById(db, conversationId);
    return NextResponse.json({ conversation });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "conversation_failed" },
      { status: 500 },
    );
  }
}
