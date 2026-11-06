import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { markConversationRead } from "@/lib/db/repos/conversations";
import { getSessionUserId } from "@/lib/rbac/session";

export async function POST(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const conversationId = String(body?.conversationId ?? "");
  if (!conversationId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const db = await getUserDb();
  const { error } = await markConversationRead(db, conversationId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
