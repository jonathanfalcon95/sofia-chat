import { scope, type Access } from "../access";
import { accessOf, failure, type SqlDb, type SqlResult } from "../db";
import { isUuid, join, raw, sql, uuidList, where, type SqlFragment } from "../sql";
import { messageVisible, rows, utc } from "./shared";

type Condition = SqlFragment | null;

/** `head: true` with `count: "exact"`: no rows, only the total. */
async function countRows(
  db: SqlDb,
  table: string,
  conditions: (access: Access | null) => Condition[],
): Promise<SqlResult<null>> {
  try {
    const access = await accessOf(db);
    const found = await db.run(
      sql`SELECT COUNT(*) AS total FROM ${raw(table)} t ${where(conditions(access))}`,
    );
    return { data: null, error: null, count: found[0].total as number };
  } catch (err) {
    return failure(err);
  }
}

function inboxFilter(inboxIds: string[] | null): Condition {
  return inboxIds ? sql`t.inbox_id IN ${uuidList(inboxIds.filter(isUuid))}` : null;
}

function readableConversations(access: Access | null): Condition {
  return access ? scope.conversationsRead(access, "t.inbox_id") : null;
}

/**
 * Reads a visibleInboxesFilter() expression, the only thing callers pass. Anything else is an error
 * rather than a wider list than the caller asked for.
 */
function visibleInboxesCondition(filter: string) {
  const parts: SqlFragment[] = [];
  const rest = filter.replace(
    /(company_id|id)\.in\.\(([^()]*)\)(?:,|$)/g,
    (_, column: string, ids: string) => {
      parts.push(sql`${raw(column)} IN ${uuidList(ids.split(",").filter(isUuid))}`);
      return "";
    },
  );
  if (rest || parts.length === 0) throw new Error("unsupported_inbox_filter");
  return sql`(${join(parts, " OR ")})`;
}

/** `orFilter` is a visibleInboxesFilter() expression; null lists every inbox. */
export async function listDashboardInboxes(db: SqlDb, orFilter: string | null) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name, company_id, is_active FROM chatbase.inboxes
      ${where([
        orFilter ? visibleInboxesCondition(orFilter) : null,
        access ? scope.inboxesRead(access, "id", "company_id") : null,
      ])}`);
  });
}

export async function listInboxNamesByIds(db: SqlDb, inboxIds: string[]) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name FROM chatbase.inboxes
      ${where([
        sql`id IN ${uuidList(inboxIds.filter(isUuid))}`,
        access ? scope.inboxesRead(access, "id", "company_id") : null,
      ])}`);
  });
}

export async function countCompanies(db: SqlDb) {
  return countRows(db, "chatbase.companies", (access) => [
    access ? scope.company(access, "t.id") : null,
  ]);
}

export async function countOpenConversations(db: SqlDb, inboxIds: string[] | null) {
  return countRows(db, "chatbase.conversations", (access) => [
    sql`t.status = N'open'`,
    inboxFilter(inboxIds),
    readableConversations(access),
  ]);
}

export async function countUnassignedOpenConversations(
  db: SqlDb,
  inboxIds: string[] | null,
) {
  return countRows(db, "chatbase.conversations", (access) => [
    sql`t.status = N'open'`,
    sql`t.assignee_id IS NULL`,
    inboxFilter(inboxIds),
    readableConversations(access),
  ]);
}

export async function countConversationsInsideWindow(
  db: SqlDb,
  nowIso: string,
  inboxIds: string[] | null,
) {
  return countRows(db, "chatbase.conversations", (access) => [
    sql`t.window_expires_at > ${utc(nowIso)}`,
    inboxFilter(inboxIds),
    readableConversations(access),
  ]);
}

export async function countConversationsOutsideWindow(
  db: SqlDb,
  nowIso: string,
  inboxIds: string[] | null,
) {
  return countRows(db, "chatbase.conversations", (access) => [
    sql`(t.window_expires_at IS NULL OR t.window_expires_at <= ${utc(nowIso)})`,
    inboxFilter(inboxIds),
    readableConversations(access),
  ]);
}

export async function countOpenConversationsInInbox(db: SqlDb, inboxId: string) {
  if (!isUuid(inboxId)) return { data: null, error: null, count: 0 };
  return countRows(db, "chatbase.conversations", (access) => [
    sql`t.inbox_id = ${inboxId}`,
    sql`t.status = N'open'`,
    readableConversations(access),
  ]);
}

export async function countTicketsByStatus(db: SqlDb, status: string) {
  return countRows(db, "chatbase.tickets", (access) => [
    sql`t.status = ${status}`,
    access ? scope.ticketsRead(access, "t.company_id") : null,
  ]);
}

/** `companyIds` null counts every company's contacts; an empty list matches nothing. */
export async function countContacts(db: SqlDb, companyIds: string[] | null) {
  return countRows(db, "chatbase.contacts", (access) => [
    companyIds ? sql`t.company_id IN ${uuidList(companyIds.filter(isUuid))}` : null,
    access ? scope.company(access, "t.company_id") : null,
  ]);
}

export async function countMessagesSince(
  db: SqlDb,
  direction: string,
  sinceIso: string,
  inboxIds: string[] | null,
) {
  return countRows(db, "chatbase.messages", (access) => [
    sql`t.direction = ${direction}`,
    sql`t.created_at >= ${utc(sinceIso)}`,
    access ? messageVisible(access, "t.conversation_id") : null,
    inboxIds
      ? sql`EXISTS (
          SELECT 1 FROM chatbase.conversations c
          WHERE c.id = t.conversation_id
            AND c.inbox_id IN ${uuidList(inboxIds.filter(isUuid))}
            ${access ? sql`AND ${scope.conversationsRead(access, "c.inbox_id")}` : raw("")})`
      : null,
  ]);
}
