import { failure, type rows, type SqlDb } from "../db";
import type { Row } from "../connection";
import { isUuid, sql, type SqlFragment } from "../sql";

/** What a failed WITH CHECK raised. Thrown inside rows/one/done, which return it as `error`. */
export function rejectRow(): never {
  throw new Error("new row violates row-level security policy");
}

/** A list Postgres would have rejected whole, so the query answers as no rows. */
export function allUuids(ids: readonly unknown[]) {
  return ids.every(isUuid);
}

/** Row ids come back in lowercase; ids from callers may not. */
export function idKey(id: string) {
  return id.toLowerCase();
}

export function groupBy(items: Row[], column: string) {
  const groups = new Map<unknown, Row[]>();
  for (const item of items) {
    const group = groups.get(item[column]);
    if (group) group.push(item);
    else groups.set(item[column], [item]);
  }
  return groups;
}

/** `.range(from, to)`; goes after an ORDER BY. */
export function rangeClause(from: number, to: number): SqlFragment {
  return sql`OFFSET ${from} ROWS FETCH NEXT ${to - from + 1} ROWS ONLY`;
}

export async function countOf(db: SqlDb, statement: SqlFragment) {
  const found = await db.run(statement);
  return Number(found[0]?.total ?? 0);
}

/** Like `rows`, for a query whose `count: "exact"` is computed along with its rows. */
export async function paged(
  work: () => Promise<{ found: Row[]; count: number }>,
): ReturnType<typeof rows> {
  try {
    const { found, count } = await work();
    return { data: found as never, error: null, count };
  } catch (err) {
    return failure(err);
  }
}

export async function noRowsPage(): ReturnType<typeof rows> {
  return { data: [] as never, error: null, count: 0 };
}
