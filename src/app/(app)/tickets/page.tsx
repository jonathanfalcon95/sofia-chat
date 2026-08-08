import { createClient } from "@/lib/supabase/server";
import { TicketsManager } from "@/components/tickets/tickets-manager";

export default async function TicketsPage() {
  const supabase = await createClient();
  const { data: tickets } = await supabase
    .from("tickets")
    .select(
      `
      id, title, description, status, priority,
      companies ( name ),
      profiles:assignee_id ( full_name, email )
    `,
    )
    .order("created_at", { ascending: false });

  const normalized =
    tickets?.map((t) => ({
      ...t,
      companies: Array.isArray(t.companies) ? t.companies[0] : t.companies,
      profiles: Array.isArray(t.profiles) ? t.profiles[0] : t.profiles,
    })) ?? [];

  return <TicketsManager tickets={normalized as never} />;
}
