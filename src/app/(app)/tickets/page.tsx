import { createClient } from "@/lib/supabase/server";
import { listCompanySupportAgents } from "@/lib/agents";
import { getAppSession } from "@/lib/rbac/session";
import { TicketsManager } from "@/components/tickets/tickets-manager";

export default async function TicketsPage() {
  const supabase = await createClient();
  const session = await getAppSession();

  const [{ data: tickets }, supportAgents] = await Promise.all([
    supabase
      .from("tickets")
      .select(
        `
      id, title, description, status, priority, company_id, conversation_id,
      assignee_id, created_by, created_at, updated_at,
      companies ( name ),
      assignee:profiles!tickets_assignee_id_fkey ( full_name, email ),
      creator:profiles!tickets_created_by_fkey ( full_name, email ),
      conversations (
        id,
        contacts ( name, phone_number )
      )
    `,
      )
      .order("created_at", { ascending: false }),
    listCompanySupportAgents(),
  ]);

  const normalized =
    tickets?.map((t) => {
      const companies = Array.isArray(t.companies)
        ? t.companies[0]
        : t.companies;
      const assignee = Array.isArray(t.assignee) ? t.assignee[0] : t.assignee;
      const creator = Array.isArray(t.creator) ? t.creator[0] : t.creator;
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
        company_name: (companies as { name?: string } | null)?.name ?? "—",
        assignee:
          (assignee as { full_name: string | null; email: string } | null) ??
          null,
        creator:
          (creator as { full_name: string | null; email: string } | null) ??
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
      currentUserId={session?.userId ?? ""}
    />
  );
}
