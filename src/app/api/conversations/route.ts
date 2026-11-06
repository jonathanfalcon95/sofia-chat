import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { fetchConversationListPage } from "@/lib/conversations/fetch-conversation-list";
import { decodePageCursor } from "@/lib/conversations/page-cursor";
import { CONVERSATION_PAGE_SIZE } from "@/lib/conversations/types";
import { getSessionUserId } from "@/lib/rbac/session";

/** One page of the inbox list. RLS decides which conversations come back. */
export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const assigneeRaw = params.get("assignee");
  const assignee =
    assigneeRaw === "mine" || assigneeRaw === "unassigned"
      ? assigneeRaw
      : "all";

  const beforeParam = params.get("before");
  const before = beforeParam ? decodePageCursor(beforeParam) : null;
  if (beforeParam && !before) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  try {
    const db = await getUserDb();
    const page = await fetchConversationListPage(db, {
      assignee,
      currentUserId: userId,
      assigneeId: params.get("assigneeId") || undefined,
      phoneSearch: params.get("phoneSearch") ?? undefined,
      contactTagId: params.get("contactTagId") || undefined,
      companyId: params.get("companyId") || undefined,
      before,
      pageSize: CONVERSATION_PAGE_SIZE,
    });
    return NextResponse.json(page);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "conversation_list_failed" },
      { status: 500 },
    );
  }
}
