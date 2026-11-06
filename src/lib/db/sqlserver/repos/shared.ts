import { scope, type Access } from "../access";
import type { Row } from "../connection";
import * as results from "../db";
import type { SqlDb, SqlResult } from "../db";
import { join, raw, sql, type SqlFragment, type SqlValue } from "../sql";

/**
 * Rows shaped like the Supabase chain's. The repository returns the union of both backends, and
 * `never` lets callers keep the type inferred from the chain, which `any` would erase.
 */
type ChainShaped = Promise<SqlResult<never>>;

export const rows = results.rows as (work: () => Promise<Row[]>) => ChainShaped;
export const one = results.one as (work: () => Promise<Row[]>) => ChainShaped;
export const maybeOne = results.maybeOne as (work: () => Promise<Row[]>) => ChainShaped;

/** One page with `count: "exact"`. */
export async function page(
  work: () => Promise<{ found: Row[]; total: Row[] }>,
): ChainShaped {
  try {
    const { found, total } = await work();
    return { data: found as never, error: null, count: total[0].total as number };
  } catch (err) {
    return results.failure(err) as SqlResult<never>;
  }
}

/** What Postgres raised when an INSERT failed its RLS check, for `failure` to report. */
export function rlsViolation() {
  return Object.assign(new Error("new row violates row-level security policy"), {
    number: 42501,
  });
}

/** Tables with no policy for users (webhook_events, ycloud_accounts) only answer the system. */
export function isSystem(db: SqlDb) {
  return db.actor.kind === "system";
}

/**
 * ISO string in UTC. Casting text to datetime2 keeps the wall clock of an offset and drops the
 * zone, so a value in another zone would be stored wrong. Without a zone it reads as UTC, like the
 * Postgres session did.
 */
export function utc(value: string) {
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value) ? value : `${value}Z`;
  const time = new Date(zoned);
  return Number.isNaN(time.getTime()) ? value : time.toISOString();
}

/** A caller's id as Access holds it: lowercase, since Postgres compared uuids by value. */
export function accessKey(id: unknown) {
  return typeof id === "string" ? id.toLowerCase() : null;
}

/** messages_select and messages_update: the message's conversation is in a reachable inbox. */
export function messageVisible(access: Access, conversationColumn: string): SqlFragment {
  return sql`EXISTS (
    SELECT 1 FROM chatbase.conversations visible_c
    WHERE visible_c.id = ${raw(conversationColumn)}
      AND ${scope.inbox(access, "visible_c.inbox_id")})`;
}

/** Columns a generic row or patch may name. Unknown keys fail, as they do in PostgREST. */
export type WritableTable = {
  name: string;
  columns: readonly string[];
  /** jsonb in Postgres: JSON text here. */
  json?: readonly string[];
  timestamps?: readonly string[];
  /** The updated_at trigger isn't ported: every update sets it and any patched value is dropped. */
  touchesUpdatedAt?: boolean;
};

function parameter(table: WritableTable, column: string, value: unknown): SqlValue {
  if (value === null) return null;
  if (table.json?.includes(column)) return JSON.stringify(value);
  if (table.timestamps?.includes(column) && typeof value === "string") return utc(value);
  return value as SqlValue;
}

function fields(table: WritableTable, values: Record<string, unknown>) {
  // JSON.stringify drops undefined keys from a PostgREST body, so they mean "not sent".
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([column, value]) => {
      if (!table.columns.includes(column)) {
        throw new Error(`Could not find the '${column}' column of '${table.name}'`);
      }
      return {
        column,
        name: raw(`[${column}]`),
        value: sql`${parameter(table, column, value)}`,
      };
    });
}

/** The body of a SET clause, or null when the patch has nothing to write. */
export function setClause(table: WritableTable, patch: Record<string, unknown>) {
  const parts = fields(table, patch)
    .filter((field) => !(table.touchesUpdatedAt && field.column === "updated_at"))
    .map((field) => sql`${field.name} = ${field.value}`);
  if (parts.length === 0) return null;
  if (table.touchesUpdatedAt) parts.push(raw("updated_at = SYSUTCDATETIME()"));
  return join(parts, ", ");
}

export function outputInserted(columns: readonly string[]) {
  return raw(`OUTPUT ${columns.map((column) => `INSERTED.[${column}]`).join(", ")}`);
}

export function insertStatement(
  table: WritableTable,
  row: Record<string, unknown>,
  returning: readonly string[] | null,
) {
  const present = fields(table, row);
  const output = returning ? outputInserted(returning) : raw("");
  if (present.length === 0) {
    return sql`INSERT INTO ${raw(table.name)} ${output} DEFAULT VALUES`;
  }
  const names = join(present.map((field) => field.name), ", ");
  const values = join(present.map((field) => field.value), ", ");
  return sql`INSERT INTO ${raw(table.name)} (${names}) ${output} VALUES (${values})`;
}
