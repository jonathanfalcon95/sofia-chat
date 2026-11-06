import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { passwordProblem } from "@/lib/auth/login-policy";
import { setPassword } from "@/lib/auth/sql-auth";
import { usesSqlServer } from "@/lib/db/backend";
import { getSystemDb } from "@/lib/db/client";
import { isUuid } from "@/lib/db/sqlserver/sql";
import { getAppSession } from "@/lib/rbac/session";

/** A platform admin sets a new password for someone who lost theirs. Ends that user's sessions. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const password = String(body?.password ?? "");
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  if (usesSqlServer()) {
    await setPassword(id, password);
    return NextResponse.json({ ok: true });
  }

  const { error } = await (getSystemDb() as SupabaseClient).auth.admin.updateUserById(id, {
    password,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
