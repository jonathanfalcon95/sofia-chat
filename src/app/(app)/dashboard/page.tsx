import { getSystemDb, getUserDb } from "@/lib/db/client";
import {
  countCompanies,
  countContacts,
  countConversationsInsideWindow,
  countConversationsOutsideWindow,
  countMessagesSince,
  countOpenConversations,
  countOpenConversationsInInbox,
  countTicketsByStatus,
  countUnassignedOpenConversations,
  listDashboardInboxes,
  listInboxNamesByIds,
} from "@/lib/db/repos/dashboard";
import {
  getAppSession,
  sessionCompanyIds,
  sessionShowsAssignedCompanies,
} from "@/lib/rbac/session";
import {
  inboxVisibility,
  visibleInboxesFilter,
  type InboxVisibility,
} from "@/lib/rbac/visible-inboxes";
import { PageHeader } from "@/components/page-header";

type VisibleInbox = {
  id: string;
  name: string;
  company_id: string | null;
  is_active: boolean;
};

/** Shown instead of a number when a count fails: a 0 would read as real data. */
const UNAVAILABLE = "—";

const NO_VISIBILITY: InboxVisibility = {
  managedCompanyIds: [],
  assignedInboxIds: [],
  conversationCompanyIds: [],
};

export default async function DashboardPage() {
  const session = await getAppSession();
  const supabase = await getUserDb();
  const showCompanies = session
    ? sessionShowsAssignedCompanies(session)
    : false;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  // Counting thousands of rows under RLS timed out, and each timeout read as 0.
  // These queries return only totals and apply the same visibility rules here.
  const admin = getSystemDb();
  const visibility = session ? inboxVisibility(session) : NO_VISIBILITY;
  const inboxFilter = visibility ? visibleInboxesFilter(visibility) : null;

  const { data: visibleInboxes } =
    visibility && !inboxFilter
      ? { data: [] as VisibleInbox[] }
      : await listDashboardInboxes(admin, inboxFilter);
  const inboxRows = (visibleInboxes ?? []) as VisibleInbox[];
  const conversationInboxIds = inboxRows
    .filter(
      (i) =>
        !visibility ||
        visibility.conversationCompanyIds.includes(i.company_id ?? ""),
    )
    .map((i) => i.id);
  const contactCompanyIds = session ? sessionCompanyIds(session) : [];

  // Filtered by inbox for everyone but platform admins (visibility === null).
  const scopedInboxIds = visibility ? conversationInboxIds : null;

  const [
    { count: companies },
    { count: openConversations },
    { count: unassigned },
    { count: openTickets },
    { count: inProgressTickets },
    { count: contacts },
    { count: inboundToday },
    { count: outboundToday },
    { count: windowOpen },
    { count: windowClosed },
  ] = await Promise.all([
    countCompanies(supabase),
    countOpenConversations(admin, scopedInboxIds),
    countUnassignedOpenConversations(admin, scopedInboxIds),
    countTicketsByStatus(supabase, "open"),
    countTicketsByStatus(supabase, "in_progress"),
    countContacts(admin, contactCompanyIds),
    countMessagesSince(
      admin,
      "inbound",
      startOfDay.toISOString(),
      scopedInboxIds,
    ),
    countMessagesSince(
      admin,
      "outbound",
      startOfDay.toISOString(),
      scopedInboxIds,
    ),
    countConversationsInsideWindow(admin, nowIso, scopedInboxIds),
    countConversationsOutsideWindow(admin, nowIso, scopedInboxIds),
  ]);

  const activeInboxes = inboxRows.filter((i) => i.is_active);
  const inboxCounts = await Promise.all(
    activeInboxes.map(async (inbox) => {
      const { count } = await countOpenConversationsInInbox(admin, inbox.id);
      return { name: inbox.name, value: count ?? UNAVAILABLE };
    }),
  );

  const cards = [
    { label: "Chats abiertos", value: openConversations ?? UNAVAILABLE },
    { label: "Sin asignar", value: unassigned ?? UNAVAILABLE },
    { label: "Ventana 24h abierta", value: windowOpen ?? UNAVAILABLE },
    { label: "Fuera de ventana", value: windowClosed ?? UNAVAILABLE },
    { label: "Msgs inbound hoy", value: inboundToday ?? UNAVAILABLE },
    { label: "Msgs outbound hoy", value: outboundToday ?? UNAVAILABLE },
    { label: "Tickets abiertos", value: openTickets ?? UNAVAILABLE },
    { label: "Tickets en progreso", value: inProgressTickets ?? UNAVAILABLE },
    { label: "Contactos", value: contacts ?? UNAVAILABLE },
    { label: "Inboxes", value: inboxRows.length },
    ...(session?.isPlatformAdmin || !showCompanies
      ? [{ label: "Empresas", value: companies ?? UNAVAILABLE }]
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
      ? await listInboxNamesByIds(supabase, inboxIds)
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
