import { NextResponse } from "next/server";
import { usesSqlServer } from "@/lib/db/backend";
import { SESSION_COOKIE } from "@/lib/auth/session-token";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  if (!usesSqlServer()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
    return NextResponse.json({ ok: true });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
