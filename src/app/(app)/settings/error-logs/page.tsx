import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { ErrorLogsManager } from "@/components/error-logs/error-logs-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

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

  const supabase = await createClient();

  const [{ data: companies }, { data: sourceRows }] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name")
      .order("name", { ascending: true }),
    supabase.from("error_logs").select("source").limit(1000),
  ]);

  const sources = Array.from(
    new Set((sourceRows ?? []).map((r) => r.source as string).filter(Boolean)),
  ).sort();

  let query = supabase
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

  const { data: logs, count } = await query.range(from, to);

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
