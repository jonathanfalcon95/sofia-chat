import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { normalizeNotes } from "@/lib/conversations/normalize";
import { listConversationNotes } from "@/lib/db/repos/notes";
import { getSessionUserId } from "@/lib/rbac/session";

export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const conversationId =
    new URL(request.url).searchParams.get("conversationId") ?? "";
  if (!conversationId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const db = await getUserDb();
  const { data, error } = await listConversationNotes(db, conversationId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    notes: normalizeNotes(data as Array<Record<string, unknown>> | null),
  });
}
