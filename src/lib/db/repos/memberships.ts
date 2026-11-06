import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/memberships";
import type { Db } from "../types";

/** Active memberships whose role has this exact name, with their profile. */
export async function listActiveMembersByRoleName(
  db: Db,
  roleName: string,
  companyId?: string,
) {
  if (isSqlDb(db)) return sql.listActiveMembersByRoleName(db, roleName, companyId);

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

/** A user's active memberships with the company, roles, permissions and inboxes the session needs. */
export async function listActiveMembershipsForSession(db: Db, userId: string) {
  return db
    .from("company_memberships")
    .select(
      `
      id,
      company_id,
      companies ( id, name ),
      membership_roles (
        roles (
          name,
          role_permissions ( permissions ( code ) )
        )
      ),
      membership_inboxes ( inbox_id )
    `,
    )
    .eq("user_id", userId)
    .eq("is_active", true);
}

/** One page of memberships, newest first, with profile, inboxes, roles and the exact total. */
export async function listMembershipsPage(
  db: Db,
  filters: {
    companyId?: string;
    status: string;
    userIds?: string[] | null;
    membershipIds?: string[] | null;
    from: number;
    to: number;
  },
) {
  let query = db
    .from("company_memberships")
    .select(
      `
      id, company_id, user_id, is_active,
      profiles ( email, full_name ),
      membership_inboxes ( inbox_id ),
      membership_roles ( role_id, roles ( name ) )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.companyId) query = query.eq("company_id", filters.companyId);
  if (filters.status === "active") query = query.eq("is_active", true);
  if (filters.status === "inactive") query = query.eq("is_active", false);
  if (filters.userIds) query = query.in("user_id", filters.userIds);
  if (filters.membershipIds) query = query.in("id", filters.membershipIds);

  return query.range(filters.from, filters.to);
}

export async function listCompanyMembershipIds(db: Db, companyId: string) {
  return db
    .from("company_memberships")
    .select("id")
    .eq("company_id", companyId);
}

/** The membership only if it belongs to both this company and this user. */
export async function findCompanyMembership(
  db: Db,
  membershipId: string,
  companyId: string,
  userId: string,
) {
  return db
    .from("company_memberships")
    .select("id")
    .eq("id", membershipId)
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
}

export async function insertMembership(
  db: Db,
  values: { company_id: string; user_id: string; is_active: boolean },
) {
  return db
    .from("company_memberships")
    .insert(values)
    .select("id")
    .single();
}

export async function updateMembershipActive(
  db: Db,
  membershipId: string,
  isActive: boolean,
) {
  return db
    .from("company_memberships")
    .update({ is_active: isActive })
    .eq("id", membershipId);
}

export async function listMembershipIdsByRole(db: Db, roleId: string) {
  return db
    .from("membership_roles")
    .select("membership_id")
    .eq("role_id", roleId);
}

export async function deleteMembershipRoles(db: Db, membershipId: string) {
  return db
    .from("membership_roles")
    .delete()
    .eq("membership_id", membershipId);
}

export async function insertMembershipRole(
  db: Db,
  values: { membership_id: string; role_id: string },
) {
  return db.from("membership_roles").insert(values);
}

export async function deleteMembershipInboxes(db: Db, membershipId: string) {
  return db
    .from("membership_inboxes")
    .delete()
    .eq("membership_id", membershipId);
}

/** Removes only these inboxes from only these memberships. */
export async function deleteMembershipInboxLinks(
  db: Db,
  membershipIds: string[],
  inboxIds: string[],
) {
  return db
    .from("membership_inboxes")
    .delete()
    .in("membership_id", membershipIds)
    .in("inbox_id", inboxIds);
}

export async function insertMembershipInboxes(
  db: Db,
  rows: Array<{ membership_id: string; inbox_id: string }>,
) {
  return db.from("membership_inboxes").insert(rows);
}
