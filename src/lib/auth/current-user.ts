import { cache } from "react";
import { cookies } from "next/headers";
import { usesSqlServer } from "@/lib/db/backend";
import { createClient } from "@/lib/supabase/server";
import { readSessionToken, SESSION_COOKIE } from "./session-token";
import { activeSessionVersion } from "./sql-auth";

/**
 * Who is signed in, once per request. On SQL Server this also checks the session version, so a
 * password change or a disabled account takes effect immediately.
 */
export const getCurrentUserId = cache(async (): Promise<string | null> => {
  if (usesSqlServer()) {
    const cookieStore = await cookies();
    const claims = await readSessionToken(cookieStore.get(SESSION_COOKIE)?.value);
    if (!claims) return null;
    const version = await activeSessionVersion(claims.userId);
    return version === claims.sessionVersion ? claims.userId : null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  return error || !userId ? null : userId;
});
