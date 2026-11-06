import { accessOf, done, one, rows, type SqlDb } from "../db";
import { hasPermission, scope, type Access } from "../access";
import { isUuid, sql, uuidList, where } from "../sql";
import { allUuids, idKey, rejectRow } from "./support";

type TagValues = {
  company_id: string;
  name: string;
  color: string;
  position: number;
  is_kanban_column: boolean;
};

/** tags_mutate, as a condition on the row. */
function tagWritable(access: Access | null) {
  if (!access) return null;
  return sql`(${scope.companyWith(access, "company_id", "kanban.manage", "inboxes.manage")}
    OR (${scope.companyWith(access, "company_id", "tags.manage")} AND is_kanban_column = 0))`;
}

/** tags_mutate, as the WITH CHECK on a new row. */
function canWriteTag(access: Access, tag: TagValues) {
  const company = idKey(tag.company_id);
  return (
    hasPermission(access, company, "kanban.manage") ||
    hasPermission(access, company, "inboxes.manage") ||
    (hasPermission(access, company, "tags.manage") && !tag.is_kanban_column)
  );
}

export async function insertTag(db: SqlDb, values: TagValues) {
  return insertTags(db, [values]);
}

export async function insertTags(db: SqlDb, tags: TagValues[]) {
  return done(async () => {
    const access = await accessOf(db);
    if (access && !tags.every((tag) => canWriteTag(access, tag))) rejectRow();
    await db.run(sql`
      INSERT INTO chatbase.tags (company_id, name, color, position, is_kanban_column)
      SELECT company_id, name, color, position, is_kanban_column
      FROM OPENJSON(${JSON.stringify(tags)}) WITH (
        company_id uniqueidentifier,
        -- Unbounded here: a narrower type would cut long text silently, not fail like the column.
        name nvarchar(max),
        color nvarchar(max),
        position int,
        is_kanban_column bit
      )`);
  });
}

/** Kanban columns are not contact tags, so they never match here. */
export async function updateContactTagById(
  db: SqlDb,
  id: string,
  values: { name: string; color: string },
) {
  return done(async () => {
    if (!isUuid(id)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.tags
      SET name = ${values.name}, color = ${values.color}
      ${where([sql`id = ${id}`, sql`is_kanban_column = 0`, tagWritable(access)])}`);
  });
}

/** Kanban columns are not contact tags, so they never match here. */
export async function deleteContactTagById(db: SqlDb, id: string) {
  return done(async () => {
    if (!isUuid(id)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE FROM chatbase.tags
      ${where([sql`id = ${id}`, sql`is_kanban_column = 0`, tagWritable(access)])}`);
  });
}

/** The given ids that are contact tags of this company. */
export async function listCompanyContactTagIds(
  db: SqlDb,
  companyId: string,
  tagIds: string[],
) {
  return rows(async () => {
    if (!isUuid(companyId) || !allUuids(tagIds)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id
      FROM chatbase.tags
      ${where([
        sql`company_id = ${companyId}`,
        sql`is_kanban_column = 0`,
        sql`id IN ${uuidList(tagIds)}`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

export async function deleteContactTagLinks(db: SqlDb, contactId: string) {
  return done(async () => {
    if (!isUuid(contactId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE ct
      FROM chatbase.contact_tags ct
      ${where([
        sql`ct.contact_id = ${contactId}`,
        access
          ? sql`EXISTS (
              SELECT 1 FROM chatbase.contacts c
              WHERE c.id = ct.contact_id
                AND ${scope.companyWith(access, "c.company_id", "conversations.tag")})`
          : null,
      ])}`);
  });
}

/**
 * The kanban check comes first, as the BEFORE INSERT trigger ran ahead of WITH CHECK. That trigger
 * read tags with the caller's rights, so a tag the user can't see never tripped it.
 */
export async function insertContactTagLinks(
  db: SqlDb,
  links: Array<{ contact_id: string; tag_id: string }>,
) {
  return done(async () => {
    const access = await accessOf(db);

    const kanban = await db.run(sql`
      SELECT TOP (1) id
      FROM chatbase.tags
      ${where([
        sql`id IN ${uuidList(links.map((link) => link.tag_id))}`,
        sql`is_kanban_column = 1`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
    if (kanban.length) throw new Error("Kanban tags cannot be assigned to contacts");

    if (access) {
      const contacts = await db.run(sql`
        SELECT id, company_id
        FROM chatbase.contacts
        WHERE id IN ${uuidList(links.map((link) => link.contact_id))}`);
      const companyOf = new Map(contacts.map((c) => [c.id, c.company_id as string]));
      for (const link of links) {
        const company = companyOf.get(idKey(link.contact_id));
        if (!company || !hasPermission(access, company, "conversations.tag")) rejectRow();
      }
    }

    await db.run(sql`
      INSERT INTO chatbase.contact_tags (contact_id, tag_id)
      SELECT contact_id, tag_id
      FROM OPENJSON(${JSON.stringify(links)}) WITH (
        contact_id uniqueidentifier,
        tag_id uniqueidentifier
      )`);
  });
}

export async function getContactCompanyId(db: SqlDb, contactId: string) {
  return one(async () => {
    if (!isUuid(contactId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, company_id
      FROM chatbase.contacts
      ${where([
        sql`id = ${contactId}`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

export async function updateContactDetails(
  db: SqlDb,
  id: string,
  values: { name: string; phone_number: string },
) {
  return done(async () => {
    if (!isUuid(id)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.contacts
      SET name = ${values.name},
          phone_number = ${values.phone_number},
          updated_at = SYSUTCDATETIME()
      ${where([sql`id = ${id}`, access ? scope.company(access, "company_id") : null])}`);
  });
}
