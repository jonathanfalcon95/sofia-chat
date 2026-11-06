import { accessOf, done, maybeOne, one, rows, type SqlDb } from "../db";
import { hasPermission, scope, type Access } from "../access";
import { ilikeToLike } from "../ilike";
import { FALSE_SQL, isUuid, raw, sql, textList, uuidList, where } from "../sql";
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

/** is_platform_permission_id: fixed codes only a platform admin may grant or revoke. */
const PLATFORM_CODES = raw("(N'companies.manage', N'roles.manage', N'error_logs.view')");

/** role_permissions_delete, for a row with these columns. */
function rolePermissionWritable(access: Access | null, roleColumn: string, permissionColumn: string) {
  if (!access) return null;
  const onManagedRole = sql`EXISTS (
    SELECT 1 FROM chatbase.roles r
    WHERE r.id = ${raw(roleColumn)}
      AND r.company_id IS NOT NULL
      AND ${scope.companyWith(access, "r.company_id", "roles.manage")})`;
  if (access.isPlatformAdmin) return onManagedRole;
  return sql`${onManagedRole} AND NOT EXISTS (
    SELECT 1 FROM chatbase.permissions p
    WHERE p.id = ${raw(permissionColumn)} AND p.code IN ${PLATFORM_CODES})`;
}

/** Roles with no company: the templates copied into every new company. */
export async function listTemplateRolesWithPermissions(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    const roles = await db.run(sql`
      SELECT r.id, r.name, r.description
      FROM chatbase.roles r
      ${where([
        sql`r.company_id IS NULL`,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
    if (!roles.length) return [];

    const links = await db.run(sql`
      SELECT rp.role_id, rp.permission_id
      FROM chatbase.role_permissions rp
      JOIN chatbase.roles r ON r.id = rp.role_id
      ${where([
        sql`rp.role_id IN ${uuidList(roles.map((r) => r.id as string))}`,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
    const byRole = groupBy(links, "role_id");
    return roles.map((role) => ({
      ...role,
      role_permissions: (byRole.get(role.id) ?? []).map((link) => ({
        permission_id: link.permission_id,
      })),
    }));
  });
}

export async function insertRole(
  db: SqlDb,
  values: {
    company_id: string;
    name: string;
    description: string | null;
    is_system: boolean;
  },
) {
  return one(async () => {
    const access = await accessOf(db);
    if (
      access &&
      !(values.company_id && hasPermission(access, idKey(values.company_id), "roles.manage"))
    ) {
      rejectRow();
    }
    return db.run(sql`
      INSERT INTO chatbase.roles (company_id, name, description, is_system)
      OUTPUT INSERTED.id
      VALUES (${values.company_id}, ${values.name}, ${values.description}, ${values.is_system})`);
  });
}

export async function updateCompanyRole(
  db: SqlDb,
  id: string,
  companyId: string,
  values: { name: string; description: string | null },
) {
  return done(async () => {
    if (!isUuid(id) || !isUuid(companyId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.roles
      SET name = ${values.name},
          description = ${values.description},
          updated_at = SYSUTCDATETIME()
      ${where([
        sql`id = ${id}`,
        sql`company_id = ${companyId}`,
        access ? scope.companyWith(access, "company_id", "roles.manage") : null,
      ])}`);
  });
}

export async function findCompanyRole(
  db: SqlDb,
  roleId: string,
  companyId: string,
) {
  return maybeOne(async () => {
    if (!isUuid(roleId) || !isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT r.id
      FROM chatbase.roles r
      ${where([
        sql`r.id = ${roleId}`,
        sql`r.company_id = ${companyId}`,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
  });
}

/** Every role that belongs to a company (templates excluded). */
export async function listCompanyRoles(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT r.id, r.name, r.company_id
      FROM chatbase.roles r
      ${where([
        sql`r.company_id IS NOT NULL`,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
  });
}

/** One page of company roles by name, with their company, permission codes and exact total. */
export async function listCompanyRolesPage(
  db: SqlDb,
  filters: {
    companyId?: string;
    namePattern?: string;
    from: number;
    to: number;
  },
) {
  if (filters.companyId && !isUuid(filters.companyId)) return noRowsPage();

  return paged(async () => {
    const access = await accessOf(db);
    const filter = where([
      sql`r.company_id IS NOT NULL`,
      filters.companyId ? sql`r.company_id = ${filters.companyId}` : null,
      filters.namePattern ? sql`r.name LIKE ${ilikeToLike(filters.namePattern)}` : null,
      access ? scope.rolesRead(access, "r.company_id") : null,
    ]);
    const [roles, count] = await Promise.all([
      db.run(sql`
        SELECT r.id, r.name, r.description, r.is_system, r.company_id,
               c.id AS embedded_company_id, c.name AS company_name
        FROM chatbase.roles r
        LEFT JOIN chatbase.companies c ON c.id = r.company_id
          ${access ? sql`AND ${scope.company(access, "c.id")}` : raw("")}
        ${filter}
        ORDER BY r.name, r.id
        ${rangeClause(filters.from, filters.to)}`),
      countOf(db, sql`SELECT COUNT(*) AS total FROM chatbase.roles r ${filter}`),
    ]);

    const codes = roles.length
      ? await db.run(sql`
          SELECT rp.role_id, p.code
          FROM chatbase.role_permissions rp
          JOIN chatbase.roles r ON r.id = rp.role_id
          JOIN chatbase.permissions p ON p.id = rp.permission_id
          ${where([
            sql`rp.role_id IN ${uuidList(roles.map((r) => r.id as string))}`,
            access ? scope.rolesRead(access, "r.company_id") : null,
          ])}`)
      : [];
    const byRole = groupBy(codes, "role_id");

    return {
      found: roles.map(({ embedded_company_id, company_name, ...role }) => ({
        ...role,
        companies: embedded_company_id ? { name: company_name } : null,
        role_permissions: (byRole.get(role.id) ?? []).map((link) => ({
          permissions: { code: link.code },
        })),
      })),
      count,
    };
  });
}

/** permissions_select is for authenticated users, with no condition beyond that. */
async function anonymous(db: SqlDb) {
  const access = await accessOf(db);
  return access !== null && !access.userId;
}

export async function listPermissions(db: SqlDb) {
  return rows(async () => {
    if (await anonymous(db)) return [];
    return db.run(sql`SELECT code, description FROM chatbase.permissions ORDER BY code`);
  });
}

export async function listPermissionsByCodes(db: SqlDb, codes: string[]) {
  return rows(async () => {
    if (await anonymous(db)) return [];
    // COLLATE: OPENJSON's value column has its own binary collation, and code's differs in name.
    return db.run(sql`
      SELECT id, code
      FROM chatbase.permissions
      WHERE code COLLATE Latin1_General_BIN2 IN ${textList(codes)}`);
  });
}

export async function insertRolePermissionRows(
  db: SqlDb,
  links: Array<{ role_id: string; permission_id: string }>,
) {
  return done(async () => {
    const access = await accessOf(db);
    if (access) {
      const roles = await db.run(sql`
        SELECT id, company_id
        FROM chatbase.roles
        WHERE id IN ${uuidList(links.map((link) => link.role_id))}`);
      const companyOf = new Map(roles.map((r) => [r.id, r.company_id as string | null]));
      for (const link of links) {
        const company = companyOf.get(idKey(link.role_id));
        if (!company || !hasPermission(access, company, "roles.manage")) rejectRow();
      }
      if (!access.isPlatformAdmin) {
        const platform = await db.run(sql`
          SELECT TOP (1) id
          FROM chatbase.permissions
          WHERE id IN ${uuidList(links.map((link) => link.permission_id))}
            AND code IN ${PLATFORM_CODES}`);
        if (platform.length) rejectRow();
      }
    }
    await db.run(sql`
      INSERT INTO chatbase.role_permissions (role_id, permission_id)
      SELECT role_id, permission_id
      FROM OPENJSON(${JSON.stringify(links)}) WITH (
        role_id uniqueidentifier,
        permission_id uniqueidentifier
      )`);
  });
}

export async function listRolePermissionCodes(db: SqlDb, roleId: string) {
  return rows(async () => {
    if (!isUuid(roleId)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT p.code
      FROM chatbase.role_permissions rp
      JOIN chatbase.roles r ON r.id = rp.role_id
      JOIN chatbase.permissions p ON p.id = rp.permission_id
      ${where([
        sql`rp.role_id = ${roleId}`,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
    return found.map((row) => ({ permissions: { code: row.code } }));
  });
}

/**
 * role_permissions has no id column on either backend, so this fails as the PostgREST query does,
 * and the failure comes back in `error`. Selecting a real key here would change what callers see.
 */
export async function listRolePermissionRows(db: SqlDb, roleId: string) {
  return rows(async () => {
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT rp.id, p.code
      FROM chatbase.role_permissions rp
      JOIN chatbase.roles r ON r.id = rp.role_id
      JOIN chatbase.permissions p ON p.id = rp.permission_id
      ${where([
        isUuid(roleId) ? sql`rp.role_id = ${roleId}` : FALSE_SQL,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
    return found.map((row) => ({ id: row.id, permissions: { code: row.code } }));
  });
}

export async function deleteRolePermissionsByRole(db: SqlDb, roleId: string) {
  return done(async () => {
    if (!isUuid(roleId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE rp
      FROM chatbase.role_permissions rp
      ${where([
        sql`rp.role_id = ${roleId}`,
        rolePermissionWritable(access, "rp.role_id", "rp.permission_id"),
      ])}`);
  });
}

/** Fails like the PostgREST query, for the reason on `listRolePermissionRows`. */
export async function deleteRolePermissionsByIds(db: SqlDb, ids: string[]) {
  return done(async () => {
    if (!allUuids(ids)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE rp
      FROM chatbase.role_permissions rp
      ${where([
        sql`rp.id IN ${uuidList(ids)}`,
        rolePermissionWritable(access, "rp.role_id", "rp.permission_id"),
      ])}`);
  });
}
