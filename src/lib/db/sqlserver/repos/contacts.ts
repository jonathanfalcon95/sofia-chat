import { escapeIlike } from "@/lib/pagination";
import { scope } from "../access";
import { accessOf, type SqlDb } from "../db";
import { FALSE_SQL, containsPattern, isUuid, raw, sql, uuidList, where } from "../sql";
import { page, rows } from "./shared";

export async function listContactTagOptions(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name, color, company_id FROM chatbase.tags
      ${where([
        sql`is_kanban_column = 0`,
        access ? scope.company(access, "company_id") : null,
      ])}
      ORDER BY name ASC`);
  });
}

export async function listCompaniesForContactFilter(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name FROM chatbase.companies
      ${where([access ? scope.company(access, "id") : null])}
      ORDER BY name ASC`);
  });
}

export async function listContactIdsByTag(db: SqlDb, tagId: string) {
  return rows(async () => {
    if (!isUuid(tagId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT ct.contact_id FROM chatbase.contact_tags ct
      ${where([
        sql`ct.tag_id = ${tagId}`,
        access
          ? sql`EXISTS (
              SELECT 1 FROM chatbase.contacts c
              WHERE c.id = ct.contact_id AND ${scope.company(access, "c.company_id")})`
          : null,
      ])}`);
  });
}

/**
 * Ids of one page of contacts with the exact total. A null list skips that filter and an empty one
 * matches nothing; an empty `companyId` or `q` skips its filter.
 */
export async function listContactIdsPage(
  db: SqlDb,
  args: {
    scopedCompanyIds: string[] | null;
    companyId: string;
    contactIds: string[] | null;
    q: string;
    from: number;
    to: number;
  },
) {
  const { scopedCompanyIds, companyId, contactIds, q, from, to } = args;

  return page(async () => {
    const access = await accessOf(db);
    // Same cleanup as ilikePattern, so a search finds the same rows on both backends.
    const pattern = q ? containsPattern(escapeIlike(q)) : null;
    const filters = where([
      access ? scope.company(access, "company_id") : null,
      scopedCompanyIds
        ? sql`company_id IN ${uuidList(scopedCompanyIds.filter(isUuid))}`
        : null,
      companyId ? (isUuid(companyId) ? sql`company_id = ${companyId}` : FALSE_SQL) : null,
      contactIds ? sql`id IN ${uuidList(contactIds.filter(isUuid))}` : null,
      pattern ? sql`(name LIKE ${pattern} OR phone_number LIKE ${pattern})` : null,
    ]);

    const [found, total] = await Promise.all([
      db.run(sql`
        SELECT id FROM chatbase.contacts ${filters}
        ORDER BY created_at DESC, id DESC
        OFFSET ${from} ROWS FETCH NEXT ${to - from + 1} ROWS ONLY`),
      db.run(sql`SELECT COUNT(*) AS total FROM chatbase.contacts ${filters}`),
    ]);

    return { found, total };
  });
}

export async function listContactsByIds(db: SqlDb, contactIds: string[]) {
  return rows(async () => {
    const ids = contactIds.filter(isUuid);
    if (ids.length === 0) return [];
    const access = await accessOf(db);

    const contacts = await db.run(sql`
      SELECT c.id, c.name, c.phone_number, c.company_id,
        co.id AS embedded_company_id, co.name AS embedded_company_name
      FROM chatbase.contacts c
      LEFT JOIN chatbase.companies co ON co.id = c.company_id
        ${access ? sql`AND ${scope.company(access, "co.id")}` : raw("")}
      ${where([
        sql`c.id IN ${uuidList(ids)}`,
        access ? scope.company(access, "c.company_id") : null,
      ])}
      ORDER BY c.created_at DESC`);
    if (contacts.length === 0) return [];

    // contact_tags_select follows the contact's company, and these contacts already passed it.
    const links = await db.run(sql`
      SELECT ct.contact_id, ct.tag_id,
        t.id AS embedded_tag_id, t.name AS embedded_tag_name, t.color AS embedded_tag_color,
        t.is_kanban_column AS embedded_tag_is_kanban_column
      FROM chatbase.contact_tags ct
      LEFT JOIN chatbase.tags t ON t.id = ct.tag_id
        ${access ? sql`AND ${scope.company(access, "t.company_id")}` : raw("")}
      WHERE ct.contact_id IN ${uuidList(contacts.map((c) => c.id as string))}`);

    return contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      phone_number: contact.phone_number,
      company_id: contact.company_id,
      companies: contact.embedded_company_id
        ? { name: contact.embedded_company_name }
        : null,
      contact_tags: links
        .filter((link) => link.contact_id === contact.id)
        .map((link) => ({
          tag_id: link.tag_id,
          tags: link.embedded_tag_id
            ? {
                id: link.embedded_tag_id,
                name: link.embedded_tag_name,
                color: link.embedded_tag_color,
                is_kanban_column: link.embedded_tag_is_kanban_column,
              }
            : null,
        })),
    }));
  });
}
