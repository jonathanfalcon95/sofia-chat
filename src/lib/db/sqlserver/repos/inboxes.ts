import { accessOf, done, rows, type SqlDb } from "../db";
import { hasPermission, scope, type Access } from "../access";
import { ilikeToLike } from "../ilike";
import { isUuid, raw, sql, uuidList, where, type SqlFragment } from "../sql";
import {
  allUuids,
  countOf,
  idKey,
  noRowsPage,
  paged,
  rangeClause,
  rejectRow,
} from "./support";

function inboxRead(access: Access | null) {
  return access ? scope.inboxesRead(access, "i.id", "i.company_id") : null;
}

/** inboxes_update's USING. A platform admin also reaches inboxes with no company. */
function inboxWritable(access: Access | null) {
  return access ? scope.companyWith(access, "company_id", "inboxes.manage") : null;
}

/**
 * WITH CHECK on a change of company: it only fails if some row got past USING. No match stays a
 * silent no-op.
 */
async function rejectIfAnyMatch(db: SqlDb, target: SqlFragment) {
  const matched = await db.run(sql`SELECT TOP (1) id FROM chatbase.inboxes ${target}`);
  if (matched.length) rejectRow();
}

export async function listCompanyInboxIds(db: SqlDb, companyId: string) {
  return rows(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT i.id
      FROM chatbase.inboxes i
      ${where([sql`i.company_id = ${companyId}`, inboxRead(access)])}`);
  });
}

export async function listInboxCompaniesByIds(db: SqlDb, ids: string[]) {
  return rows(async () => {
    if (!allUuids(ids)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT i.id, i.company_id
      FROM chatbase.inboxes i
      ${where([sql`i.id IN ${uuidList(ids)}`, inboxRead(access)])}`);
  });
}

export async function assignInboxesToCompany(
  db: SqlDb,
  ids: string[],
  companyId: string,
) {
  return done(async () => {
    if (!allUuids(ids)) return;
    const access = await accessOf(db);
    const target = where([sql`id IN ${uuidList(ids)}`, inboxWritable(access)]);
    if (access && !hasPermission(access, idKey(companyId), "inboxes.manage")) {
      await rejectIfAnyMatch(db, target);
    }
    await db.run(sql`
      UPDATE chatbase.inboxes
      SET company_id = ${companyId}, updated_at = SYSUTCDATETIME()
      ${target}`);
  });
}

/** Only releases inboxes still held by this company. */
export async function unassignCompanyInboxes(
  db: SqlDb,
  ids: string[],
  companyId: string,
) {
  return done(async () => {
    if (!allUuids(ids) || !isUuid(companyId)) return;
    const access = await accessOf(db);
    const target = where([
      sql`id IN ${uuidList(ids)}`,
      sql`company_id = ${companyId}`,
      inboxWritable(access),
    ]);
    // WITH CHECK requires a company on the new row unless the user is a platform admin.
    if (access && !access.isPlatformAdmin) await rejectIfAnyMatch(db, target);
    await db.run(sql`
      UPDATE chatbase.inboxes
      SET company_id = NULL, updated_at = SYSUTCDATETIME()
      ${target}`);
  });
}

export async function updateInboxById(
  db: SqlDb,
  id: string,
  values: { name: string; is_active: boolean },
) {
  return done(async () => {
    if (!isUuid(id)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.inboxes
      SET name = ${values.name}, is_active = ${values.is_active}, updated_at = SYSUTCDATETIME()
      ${where([sql`id = ${id}`, inboxWritable(access)])}`);
  });
}

/** The given ids that are active inboxes of this company. */
export async function listActiveCompanyInboxIds(
  db: SqlDb,
  companyId: string,
  inboxIds: string[],
) {
  return rows(async () => {
    if (!isUuid(companyId) || !allUuids(inboxIds)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT i.id
      FROM chatbase.inboxes i
      ${where([
        sql`i.company_id = ${companyId}`,
        sql`i.is_active = 1`,
        sql`i.id IN ${uuidList(inboxIds)}`,
        inboxRead(access),
      ])}`);
  });
}

export async function listActiveAssignedInboxes(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT i.id, i.name, i.company_id, i.phone_number, i.is_active
      FROM chatbase.inboxes i
      ${where([sql`i.company_id IS NOT NULL`, sql`i.is_active = 1`, inboxRead(access)])}`);
  });
}

export async function listInboxNamesByIds(db: SqlDb, ids: string[]) {
  return rows(async () => {
    if (!allUuids(ids)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT i.id, i.name
      FROM chatbase.inboxes i
      ${where([sql`i.id IN ${uuidList(ids)}`, inboxRead(access)])}`);
  });
}

export async function listAllInboxes(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT i.id, i.name, i.phone_number, i.company_id, i.is_active
      FROM chatbase.inboxes i
      ${where([inboxRead(access)])}
      ORDER BY i.name`);
  });
}

/**
 * One page of inboxes, newest first, with their company and the exact total.
 * A `companyId` of "none" selects inboxes without a company.
 */
export async function listInboxesPage(
  db: SqlDb,
  filters: {
    status: string;
    companyId?: string;
    ycloudAccountId?: string;
    searchPattern?: string;
    from: number;
    to: number;
  },
) {
  const companyId = filters.companyId === "none" ? null : filters.companyId;
  if (
    (companyId && !isUuid(companyId)) ||
    (filters.ycloudAccountId && !isUuid(filters.ycloudAccountId))
  ) {
    return noRowsPage();
  }

  return paged(async () => {
    const access = await accessOf(db);
    const like = filters.searchPattern ? ilikeToLike(filters.searchPattern) : null;
    const filter = where([
      filters.status === "active" ? sql`i.is_active = 1` : null,
      filters.status === "inactive" ? sql`i.is_active = 0` : null,
      filters.companyId === "none" ? sql`i.company_id IS NULL` : null,
      companyId ? sql`i.company_id = ${companyId}` : null,
      filters.ycloudAccountId ? sql`i.ycloud_account_id = ${filters.ycloudAccountId}` : null,
      like ? sql`(i.name LIKE ${like} OR i.phone_number LIKE ${like})` : null,
      inboxRead(access),
    ]);
    const [found, count] = await Promise.all([
      db.run(sql`
        SELECT i.id, i.name, i.phone_number, i.is_active, i.company_id,
               i.ycloud_phone_number_id, i.waba_id, i.ycloud_account_id,
               c.id AS embedded_company_id, c.name AS company_name
        FROM chatbase.inboxes i
        LEFT JOIN chatbase.companies c ON c.id = i.company_id
          ${access ? sql`AND ${scope.company(access, "c.id")}` : raw("")}
        ${filter}
        ORDER BY i.created_at DESC, i.id
        ${rangeClause(filters.from, filters.to)}`),
      countOf(db, sql`SELECT COUNT(*) AS total FROM chatbase.inboxes i ${filter}`),
    ]);
    return {
      found: found.map(({ embedded_company_id, company_name, ...inbox }) => ({
        ...inbox,
        companies: embedded_company_id ? { name: company_name } : null,
      })),
      count,
    };
  });
}
