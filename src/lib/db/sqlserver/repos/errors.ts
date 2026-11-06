import { escapeIlike } from "@/lib/pagination";
import { scope } from "../access";
import type { Row } from "../connection";
import { accessOf, done, type SqlDb } from "../db";
import { FALSE_SQL, containsPattern, isUuid, raw, sql, where } from "../sql";
import {
  insertStatement,
  isSystem,
  page,
  rlsViolation,
  rows,
  setClause,
  type WritableTable,
} from "./shared";

const ERROR_LOGS: WritableTable = {
  name: "chatbase.error_logs",
  columns: [
    "id",
    "created_at",
    "updated_at",
    "level",
    "status",
    "source",
    "message",
    "error_name",
    "error_code",
    "http_status",
    "stack",
    "context",
    "company_id",
    "user_id",
    "request_id",
    "resolved_at",
    "resolved_by",
    "resolution_note",
  ],
  json: ["context"],
  timestamps: ["created_at", "updated_at", "resolved_at"],
  touchesUpdatedAt: true,
};

export async function insertErrorLog(db: SqlDb, row: Record<string, unknown>) {
  return done(async () => {
    if (!isSystem(db)) throw rlsViolation();
    await db.run(insertStatement(ERROR_LOGS, row, null));
  });
}

export async function updateErrorLog(
  db: SqlDb,
  id: string,
  patch: Record<string, unknown>,
) {
  return done(async () => {
    if (!isUuid(id)) return;
    const set = setClause(ERROR_LOGS, patch);
    if (!set) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.error_logs SET ${set}
      ${where([sql`id = ${id}`, access ? scope.errorLogs(access) : null])}`);
  });
}

export async function listCompaniesForErrorLogFilter(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name FROM chatbase.companies
      ${where([access ? scope.company(access, "id") : null])}
      ORDER BY name ASC`);
  });
}

export async function listErrorLogSources(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (1000) source FROM chatbase.error_logs
      ${where([access ? scope.errorLogs(access) : null])}`);
  });
}

function embedErrorLog(row: Row) {
  const {
    embedded_company_id,
    embedded_company_name,
    embedded_actor_id,
    embedded_actor_full_name,
    embedded_actor_email,
    embedded_resolver_id,
    embedded_resolver_full_name,
    embedded_resolver_email,
    ...log
  } = row;
  return {
    ...log,
    companies: embedded_company_id
      ? { id: embedded_company_id, name: embedded_company_name }
      : null,
    actor: embedded_actor_id
      ? { full_name: embedded_actor_full_name, email: embedded_actor_email }
      : null,
    resolver: embedded_resolver_id
      ? { full_name: embedded_resolver_full_name, email: embedded_resolver_email }
      : null,
  };
}

/**
 * One page of incidents with the exact total. `companyId` also takes "none" (no company) and
 * "all"; `status`, `level` and `source` take "all". An empty `q` skips the text search.
 */
export async function listErrorLogsPage(
  db: SqlDb,
  args: {
    companyId: string;
    status: string;
    level: string;
    source: string;
    q: string;
    from: number;
    to: number;
  },
) {
  const { companyId, status, level, source, q, from, to } = args;

  return page(async () => {
    const access = await accessOf(db);
    // Same cleanup as ilikePattern, so a search finds the same rows on both backends.
    const pattern = q ? containsPattern(escapeIlike(q)) : null;
    const filters = where([
      access ? scope.errorLogs(access) : null,
      companyId === "none"
        ? sql`e.company_id IS NULL`
        : companyId !== "all" && companyId
          ? isUuid(companyId)
            ? sql`e.company_id = ${companyId}`
            : FALSE_SQL
          : null,
      status !== "all" ? sql`e.status = ${status}` : null,
      level !== "all" ? sql`e.level = ${level}` : null,
      source !== "all" && source ? sql`e.source = ${source}` : null,
      pattern
        ? sql`(e.message LIKE ${pattern} OR e.source LIKE ${pattern}
            OR e.error_code LIKE ${pattern} OR e.error_name LIKE ${pattern}
            OR e.request_id LIKE ${pattern})`
        : null,
    ]);

    const [found, total] = await Promise.all([
      db.run(sql`
        SELECT e.id, e.created_at, e.updated_at, e.level, e.status, e.source, e.message,
          e.error_name, e.error_code, e.http_status, e.stack, e.context,
          e.company_id, e.user_id, e.request_id,
          e.resolved_at, e.resolved_by, e.resolution_note,
          co.id AS embedded_company_id, co.name AS embedded_company_name,
          actor.id AS embedded_actor_id, actor.full_name AS embedded_actor_full_name,
          actor.email AS embedded_actor_email,
          resolver.id AS embedded_resolver_id, resolver.full_name AS embedded_resolver_full_name,
          resolver.email AS embedded_resolver_email
        FROM chatbase.error_logs e
        LEFT JOIN chatbase.companies co ON co.id = e.company_id
          ${access ? sql`AND ${scope.company(access, "co.id")}` : raw("")}
        LEFT JOIN chatbase.profiles actor ON actor.id = e.user_id
          ${access ? sql`AND ${scope.profilesRead(access, "actor.id")}` : raw("")}
        LEFT JOIN chatbase.profiles resolver ON resolver.id = e.resolved_by
          ${access ? sql`AND ${scope.profilesRead(access, "resolver.id")}` : raw("")}
        ${filters}
        ORDER BY e.created_at DESC, e.id DESC
        OFFSET ${from} ROWS FETCH NEXT ${to - from + 1} ROWS ONLY`),
      db.run(sql`SELECT COUNT(*) AS total FROM chatbase.error_logs e ${filters}`),
    ]);

    return { found: found.map(embedErrorLog), total };
  });
}
