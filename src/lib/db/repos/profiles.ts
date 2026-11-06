import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/profiles";
import type { Db } from "../types";

export async function getSessionProfile(db: Db, userId: string) {
  if (isSqlDb(db)) return sql.getSessionProfile(db, userId);

  return db
    .from("profiles")
    .select("id, email, full_name, is_platform_admin")
    .eq("id", userId)
    .single();
}

export async function updateProfileFullName(
  db: Db,
  userId: string,
  fullName: string,
) {
  if (isSqlDb(db)) return sql.updateProfileFullName(db, userId, fullName);

  return db.from("profiles").update({ full_name: fullName }).eq("id", userId);
}

/** Ids of profiles whose email or full name matches an ilike pattern. */
export async function searchProfileIds(db: Db, pattern: string) {
  if (isSqlDb(db)) return sql.searchProfileIds(db, pattern);

  return db
    .from("profiles")
    .select("id")
    .or(`email.ilike."${pattern}",full_name.ilike."${pattern}"`);
}
