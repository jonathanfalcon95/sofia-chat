import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { ErrorLogsManager } from "@/components/error-logs/error-logs-manager";

export default async function ErrorLogsPage() {
  await requireAnyPermission("error_logs.view");
  const supabase = await createClient();

  const [{ data: logs }, { data: companies }] = await Promise.all([
    supabase
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
      )
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("companies")
      .select("id, name")
      .order("name", { ascending: true }),
  ]);

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
    />
  );
}
