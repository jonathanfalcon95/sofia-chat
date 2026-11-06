import { accessOf, done, one, rows, type SqlDb } from "../db";
import { scope } from "../access";
import { ilikeToLike } from "../ilike";
import { isUuid, sql, where } from "../sql";

export async function getSessionProfile(db: SqlDb, userId: string) {
  return one(async () => {
    if (!isUuid(userId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT p.id, p.email, p.full_name, p.is_platform_admin
      FROM chatbase.profiles p
      ${where([sql`p.id = ${userId}`, access ? scope.profilesRead(access, "p.id") : null])}`);
  });
}

/** Never writes is_platform_admin, so the Super Admin guard of the old trigger has nothing to do. */
export async function updateProfileFullName(
  db: SqlDb,
  userId: string,
  fullName: string,
) {
  return done(async () => {
    if (!isUuid(userId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.profiles
      SET full_name = ${fullName}, updated_at = SYSUTCDATETIME()
      ${where([
        sql`id = ${userId}`,
        access && !access.isPlatformAdmin ? sql`id = ${access.userId}` : null,
      ])}`);
  });
}

/** Ids of profiles whose email or full name matches an ilike pattern. */
export async function searchProfileIds(db: SqlDb, pattern: string) {
  return rows(async () => {
    const access = await accessOf(db);
    const like = ilikeToLike(pattern);
    return db.run(sql`
      SELECT p.id
      FROM chatbase.profiles p
      ${where([
        sql`(p.email LIKE ${like} OR p.full_name LIKE ${like})`,
        access ? scope.profilesRead(access, "p.id") : null,
      ])}`);
  });
}
