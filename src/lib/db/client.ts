import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Db } from "./types";

/** Acts as the signed-in user: RLS decides what this handle can see or change. */
export async function getUserDb(): Promise<Db> {
  return createClient();
}

/** Bypasses RLS. Only for code that has already authorized the request, or has no user. */
export function getSystemDb(): Db {
  return createAdminClient();
}

export { hasServiceRole };
