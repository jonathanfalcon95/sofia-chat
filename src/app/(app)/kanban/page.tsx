import { createClient } from "@/lib/supabase/server";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

type ContactRel = { id: string; name: string | null; phone_number: string } | null;
type InboxRel = { name: string } | null;

export default async function KanbanPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; inboxId?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .order("name");
  const companyId = sp.companyId || companies?.[0]?.id;

  let inboxQuery = supabase.from("inboxes").select("id, name, company_id");
  if (companyId) inboxQuery = inboxQuery.eq("company_id", companyId);
  const { data: inboxes } = await inboxQuery;

  let tagsQuery = supabase
    .from("tags")
    .select("id, name, color, position, company_id")
    .eq("is_kanban_column", true)
    .order("position");
  if (companyId) tagsQuery = tagsQuery.eq("company_id", companyId);
  const { data: tags } = await tagsQuery;

  let convQuery = supabase
    .from("conversations")
    .select(
      `
      id, last_message_preview, last_message_at, inbox_id, company_id, contact_id,
      contacts ( id, name, phone_number ),
      inboxes ( name ),
      conversation_tags ( tag_id, tags ( id, is_kanban_column ) )
    `,
    )
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (companyId) convQuery = convQuery.eq("company_id", companyId);
  if (sp.inboxId) convQuery = convQuery.eq("inbox_id", sp.inboxId);
  const { data: conversations } = await convQuery;

  const defaultTagId = tags?.[0]?.id ?? null;
  const byContact = new Map<
    string,
    {
      id: string;
      contactId: string;
      preview: string | null;
      contactName: string;
      phone: string;
      inboxName: string | null;
      tagId: string | null;
      lastAt: string | null;
    }
  >();

  for (const c of conversations ?? []) {
    const contact = (
      Array.isArray(c.contacts) ? c.contacts[0] : c.contacts
    ) as ContactRel;
    const inbox = (
      Array.isArray(c.inboxes) ? c.inboxes[0] : c.inboxes
    ) as InboxRel;
    const contactId = (contact?.id || c.contact_id) as string;
    if (!contactId) continue;

    const kanbanTag = (c.conversation_tags ?? [])
      .map((ct) => ({
        tag_id: ct.tag_id as string,
        tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
      }))
      .find((ct) => ct.tags?.is_kanban_column);

    const phone = contact?.phone_number || "";
    const contactName =
      (contact?.name && contact.name !== phone ? contact.name : null) ||
      phone ||
      "Contacto";

    const candidate = {
      id: c.id as string,
      contactId,
      preview: c.last_message_preview as string | null,
      contactName,
      phone,
      inboxName: inbox?.name ?? null,
      tagId: kanbanTag?.tag_id ?? defaultTagId,
      lastAt: (c.last_message_at as string | null) ?? null,
    };

    const existing = byContact.get(contactId);
    if (!existing) {
      byContact.set(contactId, candidate);
      continue;
    }

    // Prefer conversation that already has a kanban tag; else most recent
    const existingHasTag = Boolean(
      existing.tagId && existing.tagId !== defaultTagId,
    );
    const candidateHasTag = Boolean(
      candidate.tagId && candidate.tagId !== defaultTagId,
    );
    if (candidateHasTag && !existingHasTag) {
      byContact.set(contactId, candidate);
    } else if (candidateHasTag === existingHasTag) {
      const existingTs = existing.lastAt ? Date.parse(existing.lastAt) : 0;
      const candidateTs = candidate.lastAt ? Date.parse(candidate.lastAt) : 0;
      if (candidateTs > existingTs) byContact.set(contactId, candidate);
    }
  }

  const cards = Array.from(byContact.values()).map(
    ({ lastAt: _lastAt, ...card }) => card,
  );

  return (
    <div>
      <PageHeader
        title="Kanban de ventas"
        description="Una tarjeta por contacto. Arrastra entre columnas o abre el chat."
        actions={
          <form className="flex flex-wrap gap-2">
            <select
              name="companyId"
              defaultValue={companyId}
              className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
            >
              {(companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              name="inboxId"
              defaultValue={sp.inboxId ?? ""}
              className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
            >
              <option value="">Todos los inboxes</option>
              {(inboxes ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary">
              Filtrar
            </Button>
          </form>
        }
      />
      <KanbanBoard tags={tags ?? []} cards={cards} />
    </div>
  );
}
