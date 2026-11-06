import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { listConversationsAssignedTo } from "@/lib/db/repos/conversations";
import { getSessionUserId } from "@/lib/rbac/session";

/** Conversations assigned to the signed-in user. */
export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = await getUserDb();
  const { data, error } = await listConversationsAssignedTo(db, userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data });
}
