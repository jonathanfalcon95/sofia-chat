import { ilikePattern } from "@/lib/pagination";
import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/errors";
import type { Db } from "../types";

export async function insertErrorLog(db: Db, row: Record<string, unknown>) {
  if (isSqlDb(db)) return sql.insertErrorLog(db, row);

  return db.from("error_logs").insert(row);
}

export async function updateErrorLog(
  db: Db,
  id: string,
  patch: Record<string, unknown>,
) {
  if (isSqlDb(db)) return sql.updateErrorLog(db, id, patch);

  return db.from("error_logs").update(patch).eq("id", id);
}

export async function listCompaniesForErrorLogFilter(db: Db) {
  if (isSqlDb(db)) return sql.listCompaniesForErrorLogFilter(db);

  return db
    .from("companies")
    .select("id, name")
    .order("name", { ascending: true });
}

export async function listErrorLogSources(db: Db) {
  if (isSqlDb(db)) return sql.listErrorLogSources(db);

  return db.from("error_logs").select("source").limit(1000);
}

/**
 * One page of incidents with the exact total. `companyId` also takes "none" (no company) and
 * "all"; `status`, `level` and `source` take "all". An empty `q` skips the text search.
 */
export async function listErrorLogsPage(
  db: Db,
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
  if (isSqlDb(db)) return sql.listErrorLogsPage(db, args);

  const { companyId, status, level, source, q, from, to } = args;

  let query = db
    .from("error_logs")
    .select(
      `
      id, created_at, updated_at, level, status, source, message,
      error_name, error_code, http_status, stack, context,
      company_id, user_id, request_id,
      resolved_at, resolved_by, resolution_note,
      companies ( id, name ),
      actor:profiles!error_logs_user_id_fkey ( full_name, email ),
      resolver:profiles!error_logs_resolved_by_fkey ( full_name, email )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (companyId === "none") query = query.is("company_id", null);
  else if (companyId !== "all" && companyId)
    query = query.eq("company_id", companyId);
  if (status !== "all") query = query.eq("status", status);
  if (level !== "all") query = query.eq("level", level);
  if (source !== "all" && source) query = query.eq("source", source);
  if (q) {
    const pattern = ilikePattern(q);
    query = query.or(
      `message.ilike."${pattern}",source.ilike."${pattern}",error_code.ilike."${pattern}",error_name.ilike."${pattern}",request_id.ilike."${pattern}"`,
    );
  }

  return query.range(from, to);
}
