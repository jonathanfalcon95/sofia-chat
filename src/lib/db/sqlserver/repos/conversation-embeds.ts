import type { PageCursor } from "@/lib/conversations/page-cursor";
import { hasInboxAccess, hasPermission, scope, type Access } from "../access";
import type { Row } from "../connection";
import { rows, type SqlDb, type SqlResult } from "../db";
import { isUuid, raw, sql, uuidList, where, type SqlFragment } from "../sql";
import { utc } from "./shared";

/**
 * A plain `any` for `data` would absorb the Supabase branch's array type at the dispatch line, and
 * callers mapping over `data` would stop compiling. The elements stay `any` because callers assign
 * them to their own row types, as they do with the untyped Supabase client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ListResult = SqlResult<any[] | null>;

/** `rows`, typed as a list. */
export const listRows = rows as (work: () => Promise<Row[]>) => Promise<ListResult>;

/** What RLS raised when a new row failed its WITH CHECK. */
export function rlsViolation() {
  return new Error("new row violates row-level security policy");
}

/**
 * Normalized to UTC: converting a string with an offset to datetime2 would drop the offset. Without
 * a zone it reads as UTC, like the Postgres session did. Invalid text throws.
 */
export function utcTimestamp(value: string) {
  return new Date(utc(value)).toISOString();
}

/** Rows after the cursor in a list ordered by the timestamp and then id, both descending. */
export function olderThanCursor(
  tsColumn: string,
  idColumn: string,
  cursor: PageCursor,
): SqlFragment {
  const ts = utcTimestamp(cursor.ts);
  return sql`(${raw(tsColumn)} < ${ts} OR (${raw(tsColumn)} = ${ts} AND ${raw(idColumn)} < ${cursor.id}))`;
}

/** Distinct non-null values of an id column, for the next stitched query. */
export function idsOf(found: Row[], column: string): string[] {
  const ids = found.map((row) => row[column] as string | null).filter(Boolean);
  return [...new Set(ids)] as string[];
}

/** Policies that read the parent conversation: has_inbox_access plus a permission on its company. */
export async function requireConversationPermission(
  db: SqlDb,
  access: Access | null,
  conversationId: string,
  permission: string,
) {
  if (!access) return;
  if (!isUuid(conversationId)) throw rlsViolation();
  const [conversation] = await db.run(sql`
    SELECT inbox_id, company_id FROM chatbase.conversations WHERE id = ${conversationId}`);
  if (
    !conversation ||
    !hasInboxAccess(access, conversation.inbox_id as string) ||
    !hasPermission(access, conversation.company_id as string, permission)
  ) {
    throw rlsViolation();
  }
}

/** Contacts the caller may see, by id. A hidden contact is absent, so its embed comes back null. */
export async function visibleContacts(
  db: SqlDb,
  access: Access | null,
  ids: string[],
): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const found = await db.run(sql`
    SELECT id, name, phone_number FROM chatbase.contacts
    ${where([
      sql`id IN ${uuidList(ids)}`,
      access ? scope.company(access, "company_id") : null,
    ])}`);
  return new Map(found.map((row) => [row.id as string, row]));
}

export async function visibleInboxes(
  db: SqlDb,
  access: Access | null,
  ids: string[],
): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const found = await db.run(sql`
    SELECT id, name FROM chatbase.inboxes
    ${where([
      sql`id IN ${uuidList(ids)}`,
      access ? scope.inboxesRead(access, "id", "company_id") : null,
    ])}`);
  return new Map(found.map((row) => [row.id as string, row]));
}

export async function visibleProfiles(
  db: SqlDb,
  access: Access | null,
  ids: string[],
): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const found = await db.run(sql`
    SELECT p.id, p.full_name, p.email FROM chatbase.profiles p
    ${where([
      sql`p.id IN ${uuidList(ids)}`,
      // Qualified: this condition holds a subquery whose own table also has an `id`.
      access ? scope.profilesRead(access, "p.id") : null,
    ])}`);
  return new Map(found.map((row) => [row.id as string, row]));
}

/** The `( full_name, email )` embed of a profile, or null when absent or hidden. */
export function profileEmbed(profiles: Map<string, Row>, id: unknown) {
  const profile = profiles.get(id as string);
  return profile ? { full_name: profile.full_name, email: profile.email } : null;
}
