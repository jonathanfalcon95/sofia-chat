import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionShowsAssignedCompanies,
} from "@/lib/rbac/session";
import { PageHeader } from "@/components/page-header";

export default async function DashboardPage() {
  const session = await getAppSession();
  const supabase = await createClient();
  const showCompanies = session
    ? sessionShowsAssignedCompanies(session)
    : false;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  const [
    { count: companies },
    { count: openConversations },
    { count: unassigned },
    { count: openTickets },
    { count: inProgressTickets },
    { count: inboxes },
    { count: contacts },
    { count: inboundToday },
    { count: outboundToday },
    { count: windowOpen },
    { count: windowClosed },
    { data: inboxRows },
  ] = await Promise.all([
    supabase.from("companies").select("*", { count: "exact", head: true }),
    supabase
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "open"),
    supabase
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("status", "open")
      .is("assignee_id", null),
    supabase
      .from("tickets")
      .select("*", { count: "exact", head: true })
      .eq("status", "open"),
    supabase
      .from("tickets")
      .select("*", { count: "exact", head: true })
      .eq("status", "in_progress"),
    supabase.from("inboxes").select("*", { count: "exact", head: true }),
    supabase.from("contacts").select("*", { count: "exact", head: true }),
    supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gte("created_at", startOfDay.toISOString()),
    supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("direction", "outbound")
      .gte("created_at", startOfDay.toISOString()),
    supabase
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .gt("window_expires_at", nowIso),
    supabase
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .or(`window_expires_at.is.null,window_expires_at.lte.${nowIso}`),
    supabase.from("inboxes").select("id, name").eq("is_active", true),
  ]);

  const inboxCounts = await Promise.all(
    (inboxRows ?? []).map(async (inbox) => {
      const { count } = await supabase
        .from("conversations")
        .select("*", { count: "exact", head: true })
        .eq("inbox_id", inbox.id)
        .eq("status", "open");
      return { name: inbox.name as string, value: count ?? 0 };
    }),
  );

  const cards = [
    { label: "Chats abiertos", value: openConversations ?? 0 },
    { label: "Sin asignar", value: unassigned ?? 0 },
    { label: "Ventana 24h abierta", value: windowOpen ?? 0 },
    { label: "Fuera de ventana", value: windowClosed ?? 0 },
    { label: "Msgs inbound hoy", value: inboundToday ?? 0 },
    { label: "Msgs outbound hoy", value: outboundToday ?? 0 },
    { label: "Tickets abiertos", value: openTickets ?? 0 },
    { label: "Tickets en progreso", value: inProgressTickets ?? 0 },
    { label: "Contactos", value: contacts ?? 0 },
    { label: "Inboxes", value: inboxes ?? 0 },
    ...(session?.isPlatformAdmin || !showCompanies
      ? [{ label: "Empresas", value: companies ?? 0 }]
      : []),
  ];

  let membershipDetails: Array<{
    companyName: string;
    roleNames: string[];
    inboxNames: string[];
  }> = [];

  if (session && showCompanies) {
    const inboxIds = Array.from(
      new Set(session.memberships.flatMap((m) => m.inboxIds)),
    );
    const { data: inboxNameRows } = inboxIds.length
      ? await supabase.from("inboxes").select("id, name").in("id", inboxIds)
      : { data: [] as Array<{ id: string; name: string }> };
    const inboxNameMap = new Map(
      (inboxNameRows ?? []).map((i) => [i.id, i.name]),
    );
    membershipDetails = session.memberships.map((m) => ({
      companyName: m.companyName,
      roleNames: m.roleNames,
      inboxNames: m.inboxIds
        .map((id) => inboxNameMap.get(id) || id.slice(0, 8))
        .filter(Boolean),
    }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={`Hola ${session?.fullName || session?.email}${
          session?.isPlatformAdmin ? " · Super Admin" : ""
        }`}
      />

      {showCompanies && membershipDetails.length > 0 ? (
        <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="text-sm font-bold">Tus empresas</h2>
          <p className="mb-3 text-xs text-[var(--muted)]">
            Empresas, roles e inboxes asignados
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {membershipDetails.map((m) => (
              <div
                key={m.companyName}
                className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3"
              >
                <div className="font-semibold">{m.companyName}</div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  Rol: {m.roleNames.join(", ") || "—"}
                </div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  Inboxes: {m.inboxNames.join(", ") || "Ninguno"}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
          >
            <div className="text-sm font-semibold text-[var(--muted)]">
              {card.label}
            </div>
            <div className="mt-2 text-3xl font-bold tracking-tight sofia-gradient-text">
              {card.value}
            </div>
          </div>
        ))}
      </div>

      {inboxCounts.length > 0 ? (
        <section className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <h2 className="mb-3 text-sm font-bold">Chats abiertos por inbox</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {inboxCounts.map((row) => (
              <div
                key={row.name}
                className="flex items-center justify-between rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
              >
                <span>{row.name}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
