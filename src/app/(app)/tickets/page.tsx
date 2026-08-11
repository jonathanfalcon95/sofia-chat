import { createClient } from "@/lib/supabase/server";
import { listCompanySupportAgents } from "@/lib/agents";
import {
  getAppSession,
  sessionIsTicketSupport,
  sessionTicketSupportCompanyIds,
} from "@/lib/rbac/session";
import { TicketsManager } from "@/components/tickets/tickets-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const session = await getAppSession();
  if (!session) return null;

  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const status = firstSearchParam(sp.status) ?? "all";
  const priority = firstSearchParam(sp.priority) ?? "all";
  const assignee = firstSearchParam(sp.assignee) ?? "all";

  const isSupportViewer =
    session.isPlatformAdmin || sessionIsTicketSupport(session);
  const supportCompanyIds = session.isPlatformAdmin
    ? null
    : sessionTicketSupportCompanyIds(session);

  let ticketsQuery = supabase
    .from("tickets")
    .select(
      `
      id, title, description, status, priority, company_id, conversation_id,
      assignee_id, created_by, created_at, updated_at,
      support_response, support_responded_at, support_responded_by,
      companies ( name ),
      assignee:profiles!tickets_assignee_id_fkey ( full_name, email ),
      creator:profiles!tickets_created_by_fkey ( full_name, email ),
      responder:profiles!tickets_support_responded_by_fkey ( full_name, email ),
      conversations (
        id,
        contacts ( name, phone_number )
      )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (!isSupportViewer) {
    ticketsQuery = ticketsQuery.eq("created_by", session.userId);
  }
  if (status !== "all") ticketsQuery = ticketsQuery.eq("status", status);
  if (priority !== "all") ticketsQuery = ticketsQuery.eq("priority", priority);
  if (isSupportViewer) {
    if (assignee === "mine") {
      ticketsQuery = ticketsQuery.eq("assignee_id", session.userId);
    } else if (assignee === "unassigned") {
      ticketsQuery = ticketsQuery.is("assignee_id", null);
    }
  }
  if (q) {
    const pattern = ilikePattern(q);
    ticketsQuery = ticketsQuery.or(
      `title.ilike."${pattern}",description.ilike."${pattern}"`,
    );
  }

  const [{ data: tickets, count }, supportAgents] = await Promise.all([
    ticketsQuery.range(from, to),
    listCompanySupportAgents(),
  ]);

  const normalized =
    tickets?.map((t) => {
      const companies = Array.isArray(t.companies)
        ? t.companies[0]
        : t.companies;
      const assigneeRow = Array.isArray(t.assignee) ? t.assignee[0] : t.assignee;
      const creator = Array.isArray(t.creator) ? t.creator[0] : t.creator;
      const responder = Array.isArray(t.responder)
        ? t.responder[0]
        : t.responder;
      const conversation = Array.isArray(t.conversations)
        ? t.conversations[0]
        : t.conversations;
      const contactRaw = conversation?.contacts;
      const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw;

      return {
        id: t.id as string,
        title: t.title as string,
        description: (t.description as string | null) ?? null,
        status: t.status as string,
        priority: t.priority as string,
        company_id: t.company_id as string,
        conversation_id: t.conversation_id as string,
        assignee_id: (t.assignee_id as string | null) ?? null,
        created_by: t.created_by as string,
        created_at: t.created_at as string,
        support_response: (t.support_response as string | null) ?? null,
        support_responded_at:
          (t.support_responded_at as string | null) ?? null,
        company_name: (companies as { name?: string } | null)?.name ?? "—",
        assignee:
          (assigneeRow as {
            full_name: string | null;
            email: string;
          } | null) ?? null,
        creator:
          (creator as { full_name: string | null; email: string } | null) ??
          null,
        responder:
          (responder as { full_name: string | null; email: string } | null) ??
          null,
        contact:
          (contact as { name: string | null; phone_number: string } | null) ??
          null,
      };
    }) ?? [];

  return (
    <TicketsManager
      tickets={normalized}
      supportAgents={supportAgents}
      currentUserId={session.userId}
      supportCompanyIds={supportCompanyIds}
      isSupportViewer={isSupportViewer}
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, status, priority, assignee }}
    />
  );
}
