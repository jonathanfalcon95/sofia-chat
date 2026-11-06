import { accessOf, done, maybeOne, one, rows, type SqlDb } from "../db";
import { hasPermission, scope, type Access } from "../access";
import { isUuid, raw, sql, uuidList, where, type SqlFragment } from "../sql";
import {
  allUuids,
  countOf,
  groupBy,
  idKey,
  noRowsPage,
  paged,
  rangeClause,
  rejectRow,
} from "./support";

/** membership_roles and membership_inboxes are readable through their membership's company. */
function linkReadable(access: Access | null) {
  return access ? scope.company(access, "m.company_id") : null;
}

/** membership_roles_mutate and membership_inboxes_mutate, for a row with this membership column. */
function linkWritable(access: Access | null, membershipColumn: string): SqlFragment | null {
  if (!access) return null;
  return sql`EXISTS (
    SELECT 1 FROM chatbase.company_memberships m
    WHERE m.id = ${raw(membershipColumn)}
      AND ${scope.companyWith(access, "m.company_id", "users.manage")})`;
}

/** The WITH CHECK of those policies: every membership must exist and allow it. */
async function requireLinkWritable(db: SqlDb, access: Access | null, membershipIds: string[]) {
  if (!access) return;
  const found = await db.run(sql`
    SELECT id, company_id
    FROM chatbase.company_memberships
    WHERE id IN ${uuidList(membershipIds)}`);
  const companyOf = new Map(found.map((m) => [m.id, m.company_id as string]));
  for (const id of membershipIds) {
    const company = companyOf.get(idKey(id));
    if (!company || !hasPermission(access, company, "users.manage")) rejectRow();
  }
}

/** `membership_roles ( role_id, roles ( name ) )`, plus the role's id for further embeds. */
async function embedMembershipRoles(db: SqlDb, access: Access | null, membershipIds: string[]) {
  return db.run(sql`
    SELECT mr.membership_id, mr.role_id, r.id AS visible_role_id, r.name
    FROM chatbase.membership_roles mr
    JOIN chatbase.company_memberships m ON m.id = mr.membership_id
    LEFT JOIN chatbase.roles r ON r.id = mr.role_id
      ${access ? sql`AND ${scope.rolesRead(access, "r.company_id")}` : raw("")}
    ${where([sql`mr.membership_id IN ${uuidList(membershipIds)}`, linkReadable(access)])}`);
}

/** `membership_inboxes ( inbox_id )`, grouped by membership. */
async function embedMembershipInboxes(db: SqlDb, access: Access | null, membershipIds: string[]) {
  const links = await db.run(sql`
    SELECT mi.membership_id, mi.inbox_id
    FROM chatbase.membership_inboxes mi
    JOIN chatbase.company_memberships m ON m.id = mi.membership_id
    ${where([sql`mi.membership_id IN ${uuidList(membershipIds)}`, linkReadable(access)])}`);
  return groupBy(links, "membership_id");
}

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

/** A user's active memberships with the company, roles, permissions and inboxes the session needs. */
export async function listActiveMembershipsForSession(db: SqlDb, userId: string) {
  return rows(async () => {
    if (!isUuid(userId)) return [];
    const access = await accessOf(db);
    const memberships = await db.run(sql`
      SELECT m.id, m.company_id, c.id AS embedded_company_id, c.name AS company_name
      FROM chatbase.company_memberships m
      LEFT JOIN chatbase.companies c ON c.id = m.company_id
        ${access ? sql`AND ${scope.company(access, "c.id")}` : raw("")}
      ${where([
        sql`m.user_id = ${userId}`,
        sql`m.is_active = 1`,
        access ? scope.company(access, "m.company_id") : null,
      ])}`);
    if (!memberships.length) return [];

    const ids = memberships.map((m) => m.id as string);
    const [roleLinks, inboxLinks] = await Promise.all([
      embedMembershipRoles(db, access, ids),
      embedMembershipInboxes(db, access, ids),
    ]);

    const roleIds = [
      ...new Set(roleLinks.flatMap((l) => (l.visible_role_id ? [l.visible_role_id as string] : []))),
    ];
    const codes = roleIds.length
      ? await db.run(sql`
          SELECT rp.role_id, p.code
          FROM chatbase.role_permissions rp
          JOIN chatbase.roles r ON r.id = rp.role_id
          JOIN chatbase.permissions p ON p.id = rp.permission_id
          ${where([
            sql`rp.role_id IN ${uuidList(roleIds)}`,
            access ? scope.rolesRead(access, "r.company_id") : null,
          ])}`)
      : [];

    const codesByRole = groupBy(codes, "role_id");
    const rolesByMembership = groupBy(roleLinks, "membership_id");
    return memberships.map((m) => ({
      id: m.id,
      company_id: m.company_id,
      companies: m.embedded_company_id
        ? { id: m.embedded_company_id, name: m.company_name }
        : null,
      membership_roles: (rolesByMembership.get(m.id) ?? []).map((link) => ({
        roles: link.visible_role_id
          ? {
              name: link.name,
              role_permissions: (codesByRole.get(link.visible_role_id) ?? []).map((row) => ({
                permissions: { code: row.code },
              })),
            }
          : null,
      })),
      membership_inboxes: (inboxLinks.get(m.id) ?? []).map((link) => ({
        inbox_id: link.inbox_id,
      })),
    }));
  });
}

/** One page of memberships, newest first, with profile, inboxes, roles and the exact total. */
export async function listMembershipsPage(
  db: SqlDb,
  filters: {
    companyId?: string;
    status: string;
    userIds?: string[] | null;
    membershipIds?: string[] | null;
    from: number;
    to: number;
  },
) {
  if (
    (filters.companyId && !isUuid(filters.companyId)) ||
    !allUuids(filters.userIds ?? []) ||
    !allUuids(filters.membershipIds ?? [])
  ) {
    return noRowsPage();
  }

  return paged(async () => {
    const access = await accessOf(db);
    const filter = where([
      filters.companyId ? sql`m.company_id = ${filters.companyId}` : null,
      filters.status === "active" ? sql`m.is_active = 1` : null,
      filters.status === "inactive" ? sql`m.is_active = 0` : null,
      filters.userIds ? sql`m.user_id IN ${uuidList(filters.userIds)}` : null,
      filters.membershipIds ? sql`m.id IN ${uuidList(filters.membershipIds)}` : null,
      access ? scope.company(access, "m.company_id") : null,
    ]);
    const [memberships, count] = await Promise.all([
      db.run(sql`
        SELECT m.id, m.company_id, m.user_id, m.is_active,
               p.id AS embedded_profile_id, p.email, p.full_name
        FROM chatbase.company_memberships m
        LEFT JOIN chatbase.profiles p ON p.id = m.user_id
          ${access ? sql`AND ${scope.profilesRead(access, "p.id")}` : raw("")}
        ${filter}
        ORDER BY m.created_at DESC, m.id
        ${rangeClause(filters.from, filters.to)}`),
      countOf(db, sql`SELECT COUNT(*) AS total FROM chatbase.company_memberships m ${filter}`),
    ]);

    if (!memberships.length) return { found: [], count };

    const ids = memberships.map((m) => m.id as string);
    const [roleLinks, inboxLinks] = await Promise.all([
      embedMembershipRoles(db, access, ids),
      embedMembershipInboxes(db, access, ids),
    ]);
    const rolesByMembership = groupBy(roleLinks, "membership_id");

    return {
      found: memberships.map(({ embedded_profile_id, email, full_name, ...m }) => ({
        ...m,
        profiles: embedded_profile_id ? { email, full_name } : null,
        membership_inboxes: (inboxLinks.get(m.id) ?? []).map((link) => ({
          inbox_id: link.inbox_id,
        })),
        membership_roles: (rolesByMembership.get(m.id) ?? []).map((link) => ({
          role_id: link.role_id,
          roles: link.visible_role_id ? { name: link.name } : null,
        })),
      })),
      count,
    };
  });
}

export async function listCompanyMembershipIds(db: SqlDb, companyId: string) {
  return rows(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id
      FROM chatbase.company_memberships
      ${where([
        sql`company_id = ${companyId}`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

/** The membership only if it belongs to both this company and this user. */
export async function findCompanyMembership(
  db: SqlDb,
  membershipId: string,
  companyId: string,
  userId: string,
) {
  return maybeOne(async () => {
    if (!isUuid(membershipId) || !isUuid(companyId) || !isUuid(userId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id
      FROM chatbase.company_memberships
      ${where([
        sql`id = ${membershipId}`,
        sql`company_id = ${companyId}`,
        sql`user_id = ${userId}`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

export async function insertMembership(
  db: SqlDb,
  values: { company_id: string; user_id: string; is_active: boolean },
) {
  return one(async () => {
    const access = await accessOf(db);
    if (access && !hasPermission(access, idKey(values.company_id), "users.manage")) rejectRow();
    return db.run(sql`
      INSERT INTO chatbase.company_memberships (company_id, user_id, is_active)
      OUTPUT INSERTED.id
      VALUES (${values.company_id}, ${values.user_id}, ${values.is_active})`);
  });
}

export async function updateMembershipActive(
  db: SqlDb,
  membershipId: string,
  isActive: boolean,
) {
  return done(async () => {
    if (!isUuid(membershipId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.company_memberships
      SET is_active = ${isActive}
      ${where([
        sql`id = ${membershipId}`,
        access ? scope.companyWith(access, "company_id", "users.manage") : null,
      ])}`);
  });
}

export async function listMembershipIdsByRole(db: SqlDb, roleId: string) {
  return rows(async () => {
    if (!isUuid(roleId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT mr.membership_id
      FROM chatbase.membership_roles mr
      JOIN chatbase.company_memberships m ON m.id = mr.membership_id
      ${where([sql`mr.role_id = ${roleId}`, linkReadable(access)])}`);
  });
}

export async function deleteMembershipRoles(db: SqlDb, membershipId: string) {
  return done(async () => {
    if (!isUuid(membershipId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE mr
      FROM chatbase.membership_roles mr
      ${where([
        sql`mr.membership_id = ${membershipId}`,
        linkWritable(access, "mr.membership_id"),
      ])}`);
  });
}

export async function insertMembershipRole(
  db: SqlDb,
  values: { membership_id: string; role_id: string },
) {
  return done(async () => {
    const access = await accessOf(db);
    await requireLinkWritable(db, access, [values.membership_id]);
    await db.run(sql`
      INSERT INTO chatbase.membership_roles (membership_id, role_id)
      VALUES (${values.membership_id}, ${values.role_id})`);
  });
}

export async function deleteMembershipInboxes(db: SqlDb, membershipId: string) {
  return done(async () => {
    if (!isUuid(membershipId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE mi
      FROM chatbase.membership_inboxes mi
      ${where([
        sql`mi.membership_id = ${membershipId}`,
        linkWritable(access, "mi.membership_id"),
      ])}`);
  });
}

/** Removes only these inboxes from only these memberships. */
export async function deleteMembershipInboxLinks(
  db: SqlDb,
  membershipIds: string[],
  inboxIds: string[],
) {
  return done(async () => {
    if (!allUuids(membershipIds) || !allUuids(inboxIds)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE mi
      FROM chatbase.membership_inboxes mi
      ${where([
        sql`mi.membership_id IN ${uuidList(membershipIds)}`,
        sql`mi.inbox_id IN ${uuidList(inboxIds)}`,
        linkWritable(access, "mi.membership_id"),
      ])}`);
  });
}

export async function insertMembershipInboxes(
  db: SqlDb,
  links: Array<{ membership_id: string; inbox_id: string }>,
) {
  return done(async () => {
    const access = await accessOf(db);
    await requireLinkWritable(db, access, links.map((link) => link.membership_id));
    await db.run(sql`
      INSERT INTO chatbase.membership_inboxes (membership_id, inbox_id)
      SELECT membership_id, inbox_id
      FROM OPENJSON(${JSON.stringify(links)}) WITH (
        membership_id uniqueidentifier,
        inbox_id uniqueidentifier
      )`);
  });
}
