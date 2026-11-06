import { accessOf, rows, type SqlDb } from "../db";
import { scope } from "../access";
import { raw, sql, where } from "../sql";

/**
 * Same shape as the PostgREST embed: one row per membership with `profiles` as an object, so the
 * caller's normalization works on both backends.
 */
export async function listActiveMembersByRoleName(
  db: SqlDb,
  roleName: string,
  companyId?: string,
) {
  return rows(async () => {
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT DISTINCT m.company_id, p.id, p.full_name, p.email
      FROM chatbase.company_memberships m
      JOIN chatbase.membership_roles mr ON mr.membership_id = m.id
      JOIN chatbase.roles r ON r.id = mr.role_id AND r.name = ${roleName}
      LEFT JOIN chatbase.profiles p ON p.id = m.user_id
        ${access ? sql`AND ${scope.profilesRead(access, "p.id")}` : raw("")}
      ${where([
        sql`m.is_active = 1`,
        companyId ? sql`m.company_id = ${companyId}` : null,
        access ? scope.company(access, "m.company_id") : null,
      ])}`);
    return found.map((row) => ({
      company_id: row.company_id,
      profiles: row.id
        ? { id: row.id, full_name: row.full_name, email: row.email }
        : null,
    }));
  });
}
