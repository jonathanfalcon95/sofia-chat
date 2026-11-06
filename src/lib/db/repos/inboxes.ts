import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/inboxes";
import type { Db } from "../types";

export async function listCompanyInboxIds(db: Db, companyId: string) {
  if (isSqlDb(db)) return sql.listCompanyInboxIds(db, companyId);

  return db.from("inboxes").select("id").eq("company_id", companyId);
}

export async function listInboxCompaniesByIds(db: Db, ids: string[]) {
  if (isSqlDb(db)) return sql.listInboxCompaniesByIds(db, ids);

  return db.from("inboxes").select("id, company_id").in("id", ids);
}

export async function assignInboxesToCompany(
  db: Db,
  ids: string[],
  companyId: string,
) {
  if (isSqlDb(db)) return sql.assignInboxesToCompany(db, ids, companyId);

  return db.from("inboxes").update({ company_id: companyId }).in("id", ids);
}

/** Only releases inboxes still held by this company. */
export async function unassignCompanyInboxes(
  db: Db,
  ids: string[],
  companyId: string,
) {
  if (isSqlDb(db)) return sql.unassignCompanyInboxes(db, ids, companyId);

  return db
    .from("inboxes")
    .update({ company_id: null })
    .in("id", ids)
    .eq("company_id", companyId);
}

export async function updateInboxById(
  db: Db,
  id: string,
  values: { name: string; is_active: boolean },
) {
  if (isSqlDb(db)) return sql.updateInboxById(db, id, values);

  return db.from("inboxes").update(values).eq("id", id);
}

/** The given ids that are active inboxes of this company. */
export async function listActiveCompanyInboxIds(
  db: Db,
  companyId: string,
  inboxIds: string[],
) {
  if (isSqlDb(db)) return sql.listActiveCompanyInboxIds(db, companyId, inboxIds);

  return db
    .from("inboxes")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", inboxIds);
}

export async function listActiveAssignedInboxes(db: Db) {
  if (isSqlDb(db)) return sql.listActiveAssignedInboxes(db);

  return db
    .from("inboxes")
    .select("id, name, company_id, phone_number, is_active")
    .not("company_id", "is", null)
    .eq("is_active", true);
}

export async function listInboxNamesByIds(db: Db, ids: string[]) {
  if (isSqlDb(db)) return sql.listInboxNamesByIds(db, ids);

  return db.from("inboxes").select("id, name").in("id", ids);
}

export async function listAllInboxes(db: Db) {
  if (isSqlDb(db)) return sql.listAllInboxes(db);

  return db
    .from("inboxes")
    .select("id, name, phone_number, company_id, is_active")
    .order("name");
}

/**
 * One page of inboxes, newest first, with their company and the exact total.
 * A `companyId` of "none" selects inboxes without a company.
 */
export async function listInboxesPage(
  db: Db,
  filters: {
    status: string;
    companyId?: string;
    ycloudAccountId?: string;
    searchPattern?: string;
    from: number;
    to: number;
  },
) {
  if (isSqlDb(db)) return sql.listInboxesPage(db, filters);

  let query = db
    .from("inboxes")
    .select(
      "id, name, phone_number, is_active, company_id, ycloud_phone_number_id, waba_id, ycloud_account_id, companies(name)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.status === "active") query = query.eq("is_active", true);
  if (filters.status === "inactive") query = query.eq("is_active", false);
  if (filters.companyId === "none") query = query.is("company_id", null);
  else if (filters.companyId) query = query.eq("company_id", filters.companyId);
  if (filters.ycloudAccountId) {
    query = query.eq("ycloud_account_id", filters.ycloudAccountId);
  }
  if (filters.searchPattern) {
    const pattern = filters.searchPattern;
    query = query.or(
      `name.ilike."${pattern}",phone_number.ilike."${pattern}"`,
    );
  }

  return query.range(filters.from, filters.to);
}
