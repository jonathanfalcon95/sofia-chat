import { getCurrentUserId } from "@/lib/auth/current-user";
import { createAdminClient, hasServiceRole as hasSupabaseServiceRole } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { usesSqlServer } from "./backend";
import { systemSqlDb, userSqlDb } from "./sqlserver/db";
import type { Db } from "./types";

/** Acts as the signed-in user: the backend's row rules decide what this handle can see or change. */
export async function getUserDb(): Promise<Db> {
  if (usesSqlServer()) {
    return userSqlDb(await getCurrentUserId()) as unknown as Db;
  }
  return createClient();
}

/** Bypasses the row rules. Only for code that has already authorized the request, or has no user. */
export function getSystemDb(): Db {
  if (usesSqlServer()) return systemSqlDb() as unknown as Db;
  return createAdminClient();
}

export function hasServiceRole() {
  return usesSqlServer() || hasSupabaseServiceRole();
}
