import { NextResponse } from "next/server";
import { usesSqlServer } from "@/lib/db/backend";
import { createSessionToken, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from "@/lib/auth/session-token";
import { verifyLogin } from "@/lib/auth/sql-auth";
import { createClient } from "@/lib/supabase/server";

const INVALID = "Correo o contraseña incorrectos";
const LOCKED = "Demasiados intentos. Prueba de nuevo en unos minutos";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? "");
  const password = String(body?.password ?? "");
  if (!email || !password) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  if (!usesSqlServer()) {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ ok: true });
  }

  const result = await verifyLogin(email, password);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason === "locked" ? LOCKED : INVALID },
      { status: result.reason === "locked" ? 429 : 401 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    await createSessionToken(result.userId, result.sessionVersion),
    SESSION_COOKIE_OPTIONS,
  );
  return response;
}
