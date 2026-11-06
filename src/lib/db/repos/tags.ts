import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/tags";
import type { Db } from "../types";

type TagValues = {
  company_id: string;
  name: string;
  color: string;
  position: number;
  is_kanban_column: boolean;
};

export async function insertTag(db: Db, values: TagValues) {
  if (isSqlDb(db)) return sql.insertTag(db, values);

  return db.from("tags").insert(values);
}

export async function insertTags(db: Db, rows: TagValues[]) {
  if (isSqlDb(db)) return sql.insertTags(db, rows);

  return db.from("tags").insert(rows);
}

/** Kanban columns are not contact tags, so they never match here. */
export async function updateContactTagById(
  db: Db,
  id: string,
  values: { name: string; color: string },
) {
  if (isSqlDb(db)) return sql.updateContactTagById(db, id, values);

  return db
    .from("tags")
    .update(values)
    .eq("id", id)
    .eq("is_kanban_column", false);
}

/** Kanban columns are not contact tags, so they never match here. */
export async function deleteContactTagById(db: Db, id: string) {
  if (isSqlDb(db)) return sql.deleteContactTagById(db, id);

  return db.from("tags").delete().eq("id", id).eq("is_kanban_column", false);
}

/** The given ids that are contact tags of this company. */
export async function listCompanyContactTagIds(
  db: Db,
  companyId: string,
  tagIds: string[],
) {
  if (isSqlDb(db)) return sql.listCompanyContactTagIds(db, companyId, tagIds);

  return db
    .from("tags")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_kanban_column", false)
    .in("id", tagIds);
}

export async function deleteContactTagLinks(db: Db, contactId: string) {
  if (isSqlDb(db)) return sql.deleteContactTagLinks(db, contactId);

  return db.from("contact_tags").delete().eq("contact_id", contactId);
}

export async function insertContactTagLinks(
  db: Db,
  rows: Array<{ contact_id: string; tag_id: string }>,
) {
  if (isSqlDb(db)) return sql.insertContactTagLinks(db, rows);

  return db.from("contact_tags").insert(rows);
}

export async function getContactCompanyId(db: Db, contactId: string) {
  if (isSqlDb(db)) return sql.getContactCompanyId(db, contactId);

  return db
    .from("contacts")
    .select("id, company_id")
    .eq("id", contactId)
    .single();
}

export async function updateContactDetails(
  db: Db,
  id: string,
  values: { name: string; phone_number: string },
) {
  if (isSqlDb(db)) return sql.updateContactDetails(db, id, values);

  return db.from("contacts").update(values).eq("id", id);
}
