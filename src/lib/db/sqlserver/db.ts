import { cache } from "react";
import { buildAccess, type Access } from "./access.ts";
import { execute, transaction, type Row } from "./connection.ts";
import { sql, type SqlFragment } from "./sql.ts";

/**
 * SQL Server handle. `user` plays the role of the Supabase session client and is limited by
 * `scope` in access.ts, the port of RLS. `system` plays the role of the service role. A null user
 * id is an anonymous caller: it reaches nothing, as RLS gave it nothing.
 */
export type SqlDb = {
  readonly __sqlserver: true;
  readonly actor: { kind: "system" } | { kind: "user"; userId: string | null };
  run(statement: SqlFragment): Promise<Row[]>;
};

export function systemSqlDb(): SqlDb {
  return { __sqlserver: true, actor: { kind: "system" }, run: execute };
}

export function userSqlDb(userId: string | null): SqlDb {
  return { __sqlserver: true, actor: { kind: "user", userId }, run: execute };
}

export function isSqlDb(db: unknown): db is SqlDb {
  return typeof db === "object" && db !== null && "__sqlserver" in db;
}

/** Runs `work` in a transaction on a handle with the same actor. */
export function inTransaction<T>(db: SqlDb, work: (tx: SqlDb) => Promise<T>): Promise<T> {
  return transaction((run) => work({ ...db, run }));
}

const NO_ACCESS: AccessRowsInput = {
  isPlatformAdmin: false,
  memberships: [],
  permissions: [],
  membershipInboxes: [],
  inboxes: [],
};
type AccessRowsInput = Omit<Parameters<typeof buildAccess>[0], "userId">;

async function queryAccessRows(userId: string): Promise<AccessRowsInput> {
  const [profiles, memberships, permissions, links, inboxes] = await Promise.all([
    execute(sql`SELECT is_platform_admin FROM chatbase.profiles WHERE id = ${userId}`),
    execute(sql`SELECT id, company_id FROM chatbase.company_memberships
                WHERE user_id = ${userId} AND is_active = 1`),
    execute(sql`SELECT mr.membership_id, p.code
                FROM chatbase.company_memberships m
                JOIN chatbase.membership_roles mr ON mr.membership_id = m.id
                JOIN chatbase.role_permissions rp ON rp.role_id = mr.role_id
                JOIN chatbase.permissions p ON p.id = rp.permission_id
                WHERE m.user_id = ${userId} AND m.is_active = 1`),
    execute(sql`SELECT mi.membership_id, mi.inbox_id
                FROM chatbase.company_memberships m
                JOIN chatbase.membership_inboxes mi ON mi.membership_id = m.id
                WHERE m.user_id = ${userId} AND m.is_active = 1`),
    execute(sql`SELECT id, company_id FROM chatbase.inboxes`),
  ]);
  return {
    isPlatformAdmin: profiles[0]?.is_platform_admin === true,
    memberships: memberships.map((m) => ({ id: m.id as string, companyId: m.company_id as string })),
    permissions: permissions.map((p) => ({ membershipId: p.membership_id as string, code: p.code as string })),
    membershipInboxes: links.map((l) => ({ membershipId: l.membership_id as string, inboxId: l.inbox_id as string })),
    inboxes: inboxes.map((i) => ({ id: i.id as string, companyId: (i.company_id as string | null) ?? null })),
  };
}

/** Once per request: every repository call of a page shares these queries. */
const accessForUser = cache(async (userId: string): Promise<Access> =>
  buildAccess({ userId, ...(await queryAccessRows(userId)) }),
);

/**
 * What the actor may reach, or null for system callers, who bypass scoping like the service role.
 */
export async function accessOf(db: SqlDb): Promise<Access | null> {
  if (db.actor.kind === "system") return null;
  if (!db.actor.userId) return buildAccess({ userId: "", ...NO_ACCESS });
  return accessForUser(db.actor.userId);
}

// Results shaped like PostgREST's, so callers written against Supabase keep working unchanged.

export type SqlResult<T> = {
  data: T;
  error: { message: string; code?: string } | null;
  count: number | null;
};

export function failure(err: unknown): SqlResult<never> {
  const e = err as { message?: string; number?: number };
  return {
    data: null as never,
    error: { message: e?.message ?? "sql_error", code: e?.number ? String(e.number) : undefined },
    count: null,
  };
}

/**
 * Repositories return this next to the Supabase chain's result. `never` drops out of that union,
 * so callers keep the types inferred from the chain.
 */
type ChainShaped = SqlResult<never>;

/** Like awaiting a PostgREST query: rows or `error`, never a thrown error. */
export async function rows(work: () => Promise<Row[]>, count?: number | null): Promise<ChainShaped> {
  try {
    return { data: (await work()) as never, error: null, count: count ?? null };
  } catch (err) {
    return failure(err);
  }
}

/** `.maybeSingle()`: null with no rows, an error with several. */
export async function maybeOne(work: () => Promise<Row[]>): Promise<ChainShaped> {
  try {
    const found = await work();
    if (found.length > 1) {
      return { data: null as never, error: { message: "multiple_rows", code: "PGRST116" }, count: null };
    }
    return { data: (found[0] ?? null) as never, error: null, count: null };
  } catch (err) {
    return failure(err);
  }
}

/** `.single()`: an error unless there is exactly one row. */
export async function one(work: () => Promise<Row[]>): Promise<ChainShaped> {
  const result = await maybeOne(work);
  if (!result.error && !result.data) {
    return { data: null as never, error: { message: "no_rows", code: "PGRST116" }, count: null };
  }
  return result;
}

/** A write's outcome, for chains with no `.select()`. */
export async function done(work: () => Promise<unknown>): Promise<SqlResult<null>> {
  try {
    await work();
    return { data: null, error: null, count: null };
  } catch (err) {
    return failure(err);
  }
}
