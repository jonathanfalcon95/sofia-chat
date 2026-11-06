import { accessOf, done, one, rows, type SqlDb } from "../db";
import { scope } from "../access";
import { ilikeToLike } from "../ilike";
import { FALSE_SQL, isUuid, sql, uuidList, where } from "../sql";
import { allUuids, countOf, noRowsPage, paged, rangeClause, rejectRow } from "./support";

export async function insertCompany(
  db: SqlDb,
  values: { name: string; slug: string; guid_company: string | null },
) {
  return one(async () => {
    const access = await accessOf(db);
    if (access && !access.isPlatformAdmin) rejectRow();
    return db.run(sql`
      INSERT INTO chatbase.companies (name, slug, guid_company)
      OUTPUT INSERTED.id
      VALUES (${values.name}, ${values.slug}, ${values.guid_company})`);
  });
}

export async function updateCompanyById(
  db: SqlDb,
  id: string,
  values: {
    name: string;
    slug: string;
    is_active: boolean;
    guid_company: string | null;
  },
) {
  return done(async () => {
    if (!isUuid(id)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.companies
      SET name = ${values.name},
          slug = ${values.slug},
          is_active = ${values.is_active},
          guid_company = ${values.guid_company},
          updated_at = SYSUTCDATETIME()
      ${where([sql`id = ${id}`, access && !access.isPlatformAdmin ? FALSE_SQL : null])}`);
  });
}

export async function listCompanyNames(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name
      FROM chatbase.companies
      ${where([access ? scope.company(access, "id") : null])}
      ORDER BY name`);
  });
}

/** One page of companies, newest first, with the exact total. */
export async function listCompaniesPage(
  db: SqlDb,
  filters: {
    status: string;
    searchPattern?: string;
    includeIds?: string[];
    excludeIds?: string[];
    from: number;
    to: number;
  },
) {
  if (!allUuids(filters.includeIds ?? filters.excludeIds ?? [])) return noRowsPage();

  return paged(async () => {
    const access = await accessOf(db);
    const like = filters.searchPattern ? ilikeToLike(filters.searchPattern) : null;
    const filter = where([
      filters.status === "active" ? sql`is_active = 1` : null,
      filters.status === "inactive" ? sql`is_active = 0` : null,
      like ? sql`(name LIKE ${like} OR slug LIKE ${like} OR guid_company LIKE ${like})` : null,
      filters.includeIds
        ? sql`id IN ${uuidList(filters.includeIds)}`
        : filters.excludeIds
          ? sql`id NOT IN ${uuidList(filters.excludeIds)}`
          : null,
      access ? scope.company(access, "id") : null,
    ]);
    const [found, count] = await Promise.all([
      db.run(sql`
        SELECT id, name, slug, is_active, guid_company
        FROM chatbase.companies
        ${filter}
        ORDER BY created_at DESC, id
        ${rangeClause(filters.from, filters.to)}`),
      countOf(db, sql`SELECT COUNT(*) AS total FROM chatbase.companies ${filter}`),
    ]);
    return { found, count };
  });
}
