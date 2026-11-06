import { ilikePattern } from "@/lib/pagination";
import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/contacts";
import type { Db } from "../types";

export async function listContactTagOptions(db: Db) {
  if (isSqlDb(db)) return sql.listContactTagOptions(db);

  return db
    .from("tags")
    .select("id, name, color, company_id")
    .eq("is_kanban_column", false)
    .order("name");
}

export async function listCompaniesForContactFilter(db: Db) {
  if (isSqlDb(db)) return sql.listCompaniesForContactFilter(db);

  return db.from("companies").select("id, name").order("name");
}

export async function listContactIdsByTag(db: Db, tagId: string) {
  if (isSqlDb(db)) return sql.listContactIdsByTag(db, tagId);

  return db.from("contact_tags").select("contact_id").eq("tag_id", tagId);
}

/**
 * Ids of one page of contacts with the exact total. A null list skips that filter and an empty one
 * matches nothing; an empty `companyId` or `q` skips its filter.
 */
export async function listContactIdsPage(
  db: Db,
  args: {
    scopedCompanyIds: string[] | null;
    companyId: string;
    contactIds: string[] | null;
    q: string;
    from: number;
    to: number;
  },
) {
  if (isSqlDb(db)) return sql.listContactIdsPage(db, args);

  const { scopedCompanyIds, companyId, contactIds, q, from, to } = args;

  let idsQuery = db
    .from("contacts")
    .select("id", { count: "exact" })
    .order("created_at", { ascending: false });
  if (scopedCompanyIds) idsQuery = idsQuery.in("company_id", scopedCompanyIds);
  if (companyId) idsQuery = idsQuery.eq("company_id", companyId);
  if (contactIds) idsQuery = idsQuery.in("id", contactIds);
  if (q) {
    const pattern = ilikePattern(q);
    idsQuery = idsQuery.or(
      `name.ilike."${pattern}",phone_number.ilike."${pattern}"`,
    );
  }

  return idsQuery.range(from, to);
}

export async function listContactsByIds(db: Db, contactIds: string[]) {
  if (isSqlDb(db)) return sql.listContactsByIds(db, contactIds);

  return db
    .from("contacts")
    .select(
      `
      id, name, phone_number, company_id,
      companies(name),
      contact_tags ( tag_id, tags ( id, name, color, is_kanban_column ) )
    `,
    )
    .in("id", contactIds)
    .order("created_at", { ascending: false });
}
