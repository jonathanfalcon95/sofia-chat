/** Parameterized SQL. Values never reach the statement text. */
export type SqlFragment = { text: string; params: SqlValue[] };
export type SqlValue = string | number | boolean | null;

const FRAGMENT = Symbol("sql-fragment");
type Tagged = SqlFragment & { [FRAGMENT]: true };

function isFragment(value: unknown): value is Tagged {
  return typeof value === "object" && value !== null && FRAGMENT in value;
}

function fragment(text: string, params: SqlValue[]): SqlFragment {
  return { text, params, [FRAGMENT]: true } as Tagged;
}

/**
 * Tagged template: `sql\`select * from t where id = ${id}\``. Interpolated values become
 * parameters; interpolated fragments are spliced in. Date is rejected on purpose: send
 * timestamps as ISO strings, because a Date parameter would be rounded to 3.33 ms.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: Array<SqlValue | SqlFragment | undefined>
): SqlFragment {
  let text = "";
  const params: SqlValue[] = [];
  strings.forEach((part, i) => {
    text += part;
    if (i >= values.length) return;
    const value = values[i];
    if (isFragment(value)) {
      text += renumber(value.text, params.length);
      params.push(...value.params);
      return;
    }
    if (value instanceof Date || (typeof value === "object" && value !== null)) {
      throw new Error("sql: use ISO strings for dates and JSON.stringify for objects");
    }
    params.push((value ?? null) as SqlValue);
    text += `@p${params.length - 1}`;
  });
  return fragment(text, params);
}

function renumber(text: string, offset: number) {
  if (offset === 0) return text;
  return text.replace(/@p(\d+)/g, (_, n: string) => `@p${Number(n) + offset}`);
}

/** Fixed SQL text such as a column name. Never pass user input here. */
export function raw(text: string): SqlFragment {
  return fragment(text, []);
}

export const TRUE_SQL = raw("1 = 1");
export const FALSE_SQL = raw("1 = 0");

/** Joins fragments, e.g. `join([a, b], " AND ")`. Empty input gives the empty fragment. */
export function join(parts: SqlFragment[], separator: string): SqlFragment {
  return parts.reduce<SqlFragment>(
    (all, part, i) =>
      i === 0 ? part : sql`${all}${raw(separator)}${part}`,
    raw(""),
  );
}

/** `WHERE ...` over the parts, or nothing when there are none. */
export function where(parts: Array<SqlFragment | null | undefined | false>) {
  const present = parts.filter(Boolean) as SqlFragment[];
  return present.length ? sql`WHERE ${join(present, " AND ")}` : raw("");
}

/**
 * Subquery for `col IN (...)`. One JSON parameter, so lists never hit the 2,100-parameter limit.
 * An empty list matches nothing.
 */
export function uuidList(ids: readonly string[]): SqlFragment {
  return sql`(SELECT CAST([value] AS uniqueidentifier) FROM OPENJSON(${JSON.stringify(ids)}))`;
}

export function textList(values: readonly string[]): SqlFragment {
  return sql`(SELECT CAST([value] AS nvarchar(4000)) FROM OPENJSON(${JSON.stringify(values)}))`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres answered a malformed uuid with an error callers treat as "not found"; SQL Server would
 * raise 8169 instead, so repositories check ids first.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** LIKE pattern matching `text` literally anywhere. `[` is a wildcard in T-SQL, unlike Postgres. */
export function containsPattern(text: string) {
  return `%${text.replace(/[[\]%_]/g, (c) => `[${c}]`)}%`;
}
