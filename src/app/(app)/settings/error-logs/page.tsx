import { getUserDb } from "@/lib/db/client";
import {
  listCompaniesForErrorLogFilter,
  listErrorLogSources,
  listErrorLogsPage,
} from "@/lib/db/repos/errors";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { ErrorLogsManager } from "@/components/error-logs/error-logs-manager";
import { firstSearchParam, parsePageParams } from "@/lib/pagination";

export default async function ErrorLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAnyPermission("error_logs.view");
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const companyId = firstSearchParam(sp.companyId) ?? "all";
  const status = firstSearchParam(sp.status) ?? "all";
  const level = firstSearchParam(sp.level) ?? "all";
  const source = firstSearchParam(sp.source) ?? "all";

  const supabase = await getUserDb();

  const [{ data: companies }, { data: sourceRows }] = await Promise.all([
    listCompaniesForErrorLogFilter(supabase),
    listErrorLogSources(supabase),
  ]);

  const sources = Array.from(
    new Set((sourceRows ?? []).map((r) => r.source as string).filter(Boolean)),
  ).sort();

  const { data: logs, count } = await listErrorLogsPage(supabase, {
    companyId,
    status,
    level,
    source,
    q,
    from,
    to,
  });

  const normalized = (logs ?? []).map((row) => {
    const company = Array.isArray(row.companies)
      ? row.companies[0]
      : row.companies;
    const actor = Array.isArray(row.actor) ? row.actor[0] : row.actor;
    const resolver = Array.isArray(row.resolver)
      ? row.resolver[0]
      : row.resolver;

    return {
      id: row.id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      level: row.level as string,
      status: row.status as string,
      source: row.source as string,
      message: row.message as string,
      error_name: (row.error_name as string | null) ?? null,
      error_code: (row.error_code as string | null) ?? null,
      http_status: (row.http_status as number | null) ?? null,
      stack: (row.stack as string | null) ?? null,
      context: (row.context as Record<string, unknown>) ?? {},
      company_id: (row.company_id as string | null) ?? null,
      user_id: (row.user_id as string | null) ?? null,
      request_id: (row.request_id as string | null) ?? null,
      resolved_at: (row.resolved_at as string | null) ?? null,
      resolved_by: (row.resolved_by as string | null) ?? null,
      resolution_note: (row.resolution_note as string | null) ?? null,
      company_name: company?.name ?? null,
      actor: actor
        ? {
            full_name: (actor.full_name as string | null) ?? null,
            email: actor.email as string,
          }
        : null,
      resolver: resolver
        ? {
            full_name: (resolver.full_name as string | null) ?? null,
            email: resolver.email as string,
          }
        : null,
    };
  });

  return (
    <ErrorLogsManager
      logs={normalized}
      companies={(companies ?? []).map((c) => ({
        id: c.id as string,
        name: c.name as string,
      }))}
      sources={sources}
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, companyId, status, level, source }}
    />
  );
}
