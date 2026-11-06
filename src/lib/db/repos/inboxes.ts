import type { Db } from "../types";

export async function listCompanyInboxIds(db: Db, companyId: string) {
  return db.from("inboxes").select("id").eq("company_id", companyId);
}

export async function listInboxCompaniesByIds(db: Db, ids: string[]) {
  return db.from("inboxes").select("id, company_id").in("id", ids);
}

export async function assignInboxesToCompany(
  db: Db,
  ids: string[],
  companyId: string,
) {
  return db.from("inboxes").update({ company_id: companyId }).in("id", ids);
}

/** Only releases inboxes still held by this company. */
export async function unassignCompanyInboxes(
  db: Db,
  ids: string[],
  companyId: string,
) {
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
  return db.from("inboxes").update(values).eq("id", id);
}

/** The given ids that are active inboxes of this company. */
export async function listActiveCompanyInboxIds(
  db: Db,
  companyId: string,
  inboxIds: string[],
) {
  return db
    .from("inboxes")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", inboxIds);
}

export async function listActiveAssignedInboxes(db: Db) {
  return db
    .from("inboxes")
    .select("id, name, company_id, phone_number, is_active")
    .not("company_id", "is", null)
    .eq("is_active", true);
}

export async function listInboxNamesByIds(db: Db, ids: string[]) {
  return db.from("inboxes").select("id, name").in("id", ids);
}

export async function listAllInboxes(db: Db) {
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
