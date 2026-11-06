import { NextResponse } from "next/server";
import { getUserDb } from "@/lib/db/client";
import { listInboundMessagesAfter } from "@/lib/db/repos/messages";
import { getSessionUserId } from "@/lib/rbac/session";

/** Polling fallback. `after` is a timestamp passed through untouched. */
export async function GET(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const after = new URL(request.url).searchParams.get("after") ?? "";
  if (!after) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const db = await getUserDb();
  const { data, error } = await listInboundMessagesAfter(db, after);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data });
}
