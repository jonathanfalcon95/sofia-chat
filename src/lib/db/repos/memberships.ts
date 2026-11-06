import type { Db } from "../types";

/** Active memberships whose role has this exact name, with their profile. */
export async function listActiveMembersByRoleName(
  db: Db,
  roleName: string,
  companyId?: string,
) {
  let query = db
    .from("company_memberships")
    .select(
      `
      company_id,
      profiles ( id, full_name, email ),
      membership_roles!inner (
        roles!inner ( name )
      )
    `,
    )
    .eq("is_active", true)
    .eq("membership_roles.roles.name", roleName);

  if (companyId) {
    query = query.eq("company_id", companyId);
  }

  return query;
}
