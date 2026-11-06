import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/roles";
import type { Db } from "../types";

/** Roles with no company: the templates copied into every new company. */
export async function listTemplateRolesWithPermissions(db: Db) {
  if (isSqlDb(db)) return sql.listTemplateRolesWithPermissions(db);

  return db
    .from("roles")
    .select("id, name, description, role_permissions(permission_id)")
    .is("company_id", null);
}

export async function insertRole(
  db: Db,
  values: {
    company_id: string;
    name: string;
    description: string | null;
    is_system: boolean;
  },
) {
  if (isSqlDb(db)) return sql.insertRole(db, values);

  return db.from("roles").insert(values).select("id").single();
}

export async function updateCompanyRole(
  db: Db,
  id: string,
  companyId: string,
  values: { name: string; description: string | null },
) {
  if (isSqlDb(db)) return sql.updateCompanyRole(db, id, companyId, values);

  return db
    .from("roles")
    .update(values)
    .eq("id", id)
    .eq("company_id", companyId);
}

export async function findCompanyRole(
  db: Db,
  roleId: string,
  companyId: string,
) {
  if (isSqlDb(db)) return sql.findCompanyRole(db, roleId, companyId);

  return db
    .from("roles")
    .select("id")
    .eq("id", roleId)
    .eq("company_id", companyId)
    .maybeSingle();
}

/** Every role that belongs to a company (templates excluded). */
export async function listCompanyRoles(db: Db) {
  if (isSqlDb(db)) return sql.listCompanyRoles(db);

  return db
    .from("roles")
    .select("id, name, company_id")
    .not("company_id", "is", null);
}

/** One page of company roles by name, with their company, permission codes and exact total. */
export async function listCompanyRolesPage(
  db: Db,
  filters: {
    companyId?: string;
    namePattern?: string;
    from: number;
    to: number;
  },
) {
  if (isSqlDb(db)) return sql.listCompanyRolesPage(db, filters);

  let query = db
    .from("roles")
    .select(
      "id, name, description, is_system, company_id, companies(name), role_permissions(permissions(code))",
      { count: "exact" },
    )
    .not("company_id", "is", null)
    .order("name");

  if (filters.companyId) query = query.eq("company_id", filters.companyId);
  if (filters.namePattern) query = query.ilike("name", filters.namePattern);

  return query.range(filters.from, filters.to);
}

export async function listPermissions(db: Db) {
  if (isSqlDb(db)) return sql.listPermissions(db);

  return db.from("permissions").select("code, description").order("code");
}

export async function listPermissionsByCodes(db: Db, codes: string[]) {
  if (isSqlDb(db)) return sql.listPermissionsByCodes(db, codes);

  return db.from("permissions").select("id, code").in("code", codes);
}

export async function insertRolePermissionRows(
  db: Db,
  rows: Array<{ role_id: string; permission_id: string }>,
) {
  if (isSqlDb(db)) return sql.insertRolePermissionRows(db, rows);

  return db.from("role_permissions").insert(rows);
}

export async function listRolePermissionCodes(db: Db, roleId: string) {
  if (isSqlDb(db)) return sql.listRolePermissionCodes(db, roleId);

  return db
    .from("role_permissions")
    .select("permissions(code)")
    .eq("role_id", roleId);
}

export async function listRolePermissionRows(db: Db, roleId: string) {
  if (isSqlDb(db)) return sql.listRolePermissionRows(db, roleId);

  return db
    .from("role_permissions")
    .select("id, permissions(code)")
    .eq("role_id", roleId);
}

export async function deleteRolePermissionsByRole(db: Db, roleId: string) {
  if (isSqlDb(db)) return sql.deleteRolePermissionsByRole(db, roleId);

  return db.from("role_permissions").delete().eq("role_id", roleId);
}

export async function deleteRolePermissionsByIds(db: Db, ids: string[]) {
  if (isSqlDb(db)) return sql.deleteRolePermissionsByIds(db, ids);

  return db.from("role_permissions").delete().in("id", ids);
}
