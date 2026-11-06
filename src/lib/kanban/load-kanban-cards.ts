import type { SupabaseClient } from "@supabase/supabase-js";
import { clampPageSize, ilikePattern } from "@/lib/pagination";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

export type KanbanCard = {
  id: string;
  contactId: string;
  preview: string | null;
  contactName: string;
  phone: string;
  inboxName: string | null;
  tagId: string | null;
};

export type KanbanLoadFilters = {
  companyId: string;
  inboxId?: string;
  q?: string;
  assignee?: "all" | "mine" | "unassigned";
  userId?: string;
  pageSize: number;
};

type ContactRel = { id: string; name: string | null; phone_number: string } | null;
type InboxRel = { name: string } | null;

type ConvRow = {
  id: string;
  last_message_preview: string | null;
  last_message_at: string | null;
  inbox_id: string;
  company_id: string;
  contact_id: string;
  assignee_id: string | null;
  contacts: ContactRel | ContactRel[];
  inboxes: InboxRel | InboxRel[];
};

function mapCard(c: ConvRow, tagId: string | null): KanbanCard | null {
  const contact = (
    Array.isArray(c.contacts) ? c.contacts[0] : c.contacts
  ) as ContactRel;
  const inbox = (Array.isArray(c.inboxes) ? c.inboxes[0] : c.inboxes) as InboxRel;
  const contactId = (contact?.id || c.contact_id) as string;
  if (!contactId) return null;

  const phone = contact?.phone_number || "";
  const contactName =
    (contact?.name && contact.name !== phone ? contact.name : null) ||
    phone ||
    "Contacto";

  return {
    id: c.id,
    contactId,
    preview: c.last_message_preview,
    contactName,
    phone,
    inboxName: inbox?.name ?? null,
    tagId,
  };
}

function dedupeByContact(cards: KanbanCard[]): KanbanCard[] {
  const seen = new Set<string>();
  const out: KanbanCard[] = [];
  for (const card of cards) {
    if (seen.has(card.contactId)) continue;
    seen.add(card.contactId);
    out.push(card);
  }
  return out;
}

const CARD_SELECT = `
  id, last_message_preview, last_message_at, inbox_id, company_id, contact_id, assignee_id,
  contacts ( id, name, phone_number ),
  inboxes ( name )
`;

type FilterableQuery<Q> = {
  eq(column: string, value: string): Q;
  is(column: string, value: null): Q;
  or(filters: string): Q;
  ilike(column: string, pattern: string): Q;
};

async function resolveSearchContactIds(
  admin: AdminClient,
  companyId: string,
  q: string,
): Promise<string[] | null> {
  const search = q.trim();
  if (!search) return null;
  const pattern = ilikePattern(search);
  const { data: contacts, error } = await admin
    .from("contacts")
    .select("id")
    .eq("company_id", companyId)
    .or(`name.ilike."${pattern}",phone_number.ilike."${pattern}"`);
  if (error) throw new Error(`Kanban search contacts: ${error.message}`);
  return (contacts ?? []).map((c) => c.id as string);
}

/**
 * Column lookups run with the service role and only ever yield ids: with RLS a
 * column scanned thousands of rows and hit the 8s timeout. The cards themselves
 * are then read with the user's client, so RLS still decides what they can see.
 */
export async function loadKanbanColumnCards(
  supabase: SupabaseClient,
  filters: KanbanLoadFilters & {
    tagId: string;
    offset?: number;
    /** When true, also include conversations with no kanban tag. */
    includeUntagged?: boolean;
  },
): Promise<{ cards: KanbanCard[]; hasMore: boolean; nextOffset: number }> {
  const pageSize = clampPageSize(filters.pageSize);
  const offset = Math.max(0, filters.offset ?? 0);
  const fetchSize = pageSize * 2;
  const from = offset;
  const to = offset + fetchSize - 1;

  const admin = createAdminClient();
  const searchContactIds = await resolveSearchContactIds(
    admin,
    filters.companyId,
    filters.q ?? "",
  );
  const searchPattern = (filters.q ?? "").trim()
    ? ilikePattern(filters.q!.trim())
    : null;

  const withFilters = <Q,>(query: Q): Q => {
    let q = query;
    const on = () => q as unknown as FilterableQuery<Q>;
    if (filters.inboxId) q = on().eq("inbox_id", filters.inboxId);
    if (filters.assignee === "mine" && filters.userId) {
      q = on().eq("assignee_id", filters.userId);
    } else if (filters.assignee === "unassigned") {
      q = on().is("assignee_id", null);
    }
    if (searchPattern) {
      q =
        searchContactIds && searchContactIds.length > 0
          ? on().or(
              `contact_id.in.(${searchContactIds.join(",")}),last_message_preview.ilike."${searchPattern}"`,
            )
          : on().ilike("last_message_preview", searchPattern);
    }
    return q;
  };

  const { data: taggedIds, error: taggedErr } = await withFilters(
    admin
      .from("conversations")
      .select("id, conversation_tags!inner(tag_id)")
      .eq("company_id", filters.companyId)
      .eq("conversation_tags.tag_id", filters.tagId),
  )
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(from, to);
  if (taggedErr) throw new Error(`Kanban tagged: ${taggedErr.message}`);

  let untaggedIds: Array<{ id: unknown }> = [];
  if (filters.includeUntagged) {
    const { data: kanbanTags, error: tagsErr } = await admin
      .from("tags")
      .select("id")
      .eq("company_id", filters.companyId)
      .eq("is_kanban_column", true);
    if (tagsErr) throw new Error(`Kanban tags: ${tagsErr.message}`);

    // Anti-join: conversations with no link to any of this company's columns.
    const { data, error: untaggedErr } = await withFilters(
      admin
        .from("conversations")
        .select("id, conversation_tags(tag_id)")
        .eq("company_id", filters.companyId)
        .in(
          "conversation_tags.tag_id",
          (kanbanTags ?? []).map((t) => t.id as string),
        )
        .is("conversation_tags", null),
    )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .range(from, to);
    if (untaggedErr) throw new Error(`Kanban untagged: ${untaggedErr.message}`);
    untaggedIds = data ?? [];
  }

  const ids = [...(taggedIds ?? []), ...untaggedIds].map((r) => r.id as string);
  const { data: rows, error: rowsErr } = ids.length
    ? await supabase
        .from("conversations")
        .select(CARD_SELECT)
        .in("id", ids)
        .order("last_message_at", { ascending: false, nullsFirst: false })
    : { data: [], error: null };
  if (rowsErr) throw new Error(`Kanban cards: ${rowsErr.message}`);

  // Tagged cards first, then untagged, each newest first as returned.
  const tagged = new Set((taggedIds ?? []).map((r) => r.id as string));
  const allRows = (rows ?? []) as unknown as ConvRow[];
  const cards = dedupeByContact(
    [
      ...allRows.filter((r) => tagged.has(r.id)),
      ...allRows.filter((r) => !tagged.has(r.id)),
    ]
      .map((row) => mapCard(row, filters.tagId))
      .filter((c): c is KanbanCard => Boolean(c)),
  );

  const page = cards.slice(0, pageSize);
  const hasMore = cards.length > pageSize;
  return {
    cards: page,
    hasMore,
    nextOffset: offset + fetchSize,
  };
}

export async function loadAllKanbanColumns(
  supabase: SupabaseClient,
  filters: KanbanLoadFilters,
  tags: Array<{ id: string }>,
): Promise<{
  cards: KanbanCard[];
  hasMoreByTag: Record<string, boolean>;
  offsetByTag: Record<string, number>;
}> {
  const cards: KanbanCard[] = [];
  const hasMoreByTag: Record<string, boolean> = {};
  const offsetByTag: Record<string, number> = {};

  const results = await Promise.all(
    tags.map((tag, index) =>
      loadKanbanColumnCards(supabase, {
        ...filters,
        tagId: tag.id,
        offset: 0,
        includeUntagged: index === 0,
      }),
    ),
  );
  tags.forEach((tag, index) => {
    const result = results[index];
    hasMoreByTag[tag.id] = result.hasMore;
    offsetByTag[tag.id] = result.nextOffset;
    cards.push(...result.cards);
  });

  return { cards, hasMoreByTag, offsetByTag };
}
