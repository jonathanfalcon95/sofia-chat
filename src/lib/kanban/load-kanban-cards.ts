import type { SupabaseClient } from "@supabase/supabase-js";
import { clampPageSize, ilikePattern } from "@/lib/pagination";

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

async function resolveSearchContactIds(
  supabase: SupabaseClient,
  companyId: string,
  q: string,
): Promise<string[] | null> {
  const search = q.trim();
  if (!search) return null;
  const pattern = ilikePattern(search);
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("company_id", companyId)
    .or(`name.ilike."${pattern}",phone_number.ilike."${pattern}"`);
  if (error) throw new Error(`Kanban search contacts: ${error.message}`);
  return (contacts ?? []).map((c) => c.id as string);
}

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

  const searchContactIds = await resolveSearchContactIds(
    supabase,
    filters.companyId,
    filters.q ?? "",
  );
  const searchPattern = (filters.q ?? "").trim()
    ? ilikePattern(filters.q!.trim())
    : null;

  // Step 1: conversation ids for this kanban column
  const { data: tagLinks, error: tagErr } = await supabase
    .from("conversation_tags")
    .select("conversation_id")
    .eq("tag_id", filters.tagId)
    .range(0, Math.max(to + 200, 300));
  if (tagErr) throw new Error(`Kanban tag links: ${tagErr.message}`);

  const taggedIds = [
    ...new Set((tagLinks ?? []).map((l) => l.conversation_id as string)),
  ];

  let cards: KanbanCard[] = [];

  if (taggedIds.length > 0) {
    let taggedQuery = supabase
      .from("conversations")
      .select(
        `
        id, last_message_preview, last_message_at, inbox_id, company_id, contact_id, assignee_id,
        contacts ( id, name, phone_number ),
        inboxes ( name )
      `,
      )
      .eq("company_id", filters.companyId)
      .in("id", taggedIds)
      .order("last_message_at", { ascending: false });

    if (filters.inboxId) taggedQuery = taggedQuery.eq("inbox_id", filters.inboxId);
    if (filters.assignee === "mine" && filters.userId) {
      taggedQuery = taggedQuery.eq("assignee_id", filters.userId);
    } else if (filters.assignee === "unassigned") {
      taggedQuery = taggedQuery.is("assignee_id", null);
    }
    if (searchPattern) {
      if (searchContactIds && searchContactIds.length > 0) {
        taggedQuery = taggedQuery.or(
          `contact_id.in.(${searchContactIds.join(",")}),last_message_preview.ilike."${searchPattern}"`,
        );
      } else {
        taggedQuery = taggedQuery.ilike("last_message_preview", searchPattern);
      }
    }

    const { data: taggedRows, error: taggedErr } = await taggedQuery.range(
      from,
      to,
    );
    if (taggedErr) throw new Error(`Kanban tagged: ${taggedErr.message}`);

    cards = dedupeByContact(
      (taggedRows ?? [])
        .map((row) => mapCard(row as ConvRow, filters.tagId))
        .filter((c): c is KanbanCard => Boolean(c)),
    );
  }

  if (filters.includeUntagged) {
    const { data: allKanbanTags, error: tagsErr } = await supabase
      .from("tags")
      .select("id")
      .eq("company_id", filters.companyId)
      .eq("is_kanban_column", true);
    if (tagsErr) throw new Error(`Kanban tags: ${tagsErr.message}`);

    const kanbanTagIds = (allKanbanTags ?? []).map((t) => t.id as string);
    const taggedSet = new Set<string>();
    if (kanbanTagIds.length > 0) {
      const { data: links, error: linksErr } = await supabase
        .from("conversation_tags")
        .select("conversation_id")
        .in("tag_id", kanbanTagIds)
        .limit(2000);
      if (linksErr) throw new Error(`Kanban all links: ${linksErr.message}`);
      for (const l of links ?? []) taggedSet.add(l.conversation_id as string);
    }

    // Over-fetch recent conversations and keep those without a kanban tag
    let untaggedQuery = supabase
      .from("conversations")
      .select(
        `
        id, last_message_preview, last_message_at, inbox_id, company_id, contact_id, assignee_id,
        contacts ( id, name, phone_number ),
        inboxes ( name )
      `,
      )
      .eq("company_id", filters.companyId)
      .order("last_message_at", { ascending: false });

    if (filters.inboxId) untaggedQuery = untaggedQuery.eq("inbox_id", filters.inboxId);
    if (filters.assignee === "mine" && filters.userId) {
      untaggedQuery = untaggedQuery.eq("assignee_id", filters.userId);
    } else if (filters.assignee === "unassigned") {
      untaggedQuery = untaggedQuery.is("assignee_id", null);
    }
    if (searchPattern) {
      if (searchContactIds && searchContactIds.length > 0) {
        untaggedQuery = untaggedQuery.or(
          `contact_id.in.(${searchContactIds.join(",")}),last_message_preview.ilike."${searchPattern}"`,
        );
      } else {
        untaggedQuery = untaggedQuery.ilike(
          "last_message_preview",
          searchPattern,
        );
      }
    }

    const { data: recentRows, error: recentErr } = await untaggedQuery.range(
      0,
      Math.max(to + pageSize * 3, 80),
    );
    if (recentErr) throw new Error(`Kanban untagged: ${recentErr.message}`);

    const untaggedCards = dedupeByContact(
      (recentRows ?? [])
        .filter((row) => !taggedSet.has(row.id as string))
        .map((row) => mapCard(row as ConvRow, filters.tagId))
        .filter((c): c is KanbanCard => Boolean(c)),
    ).slice(offset, offset + fetchSize);

    const seen = new Set(cards.map((c) => c.contactId));
    for (const card of untaggedCards) {
      if (seen.has(card.contactId)) continue;
      seen.add(card.contactId);
      cards.push(card);
    }
  }

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

  // Sequential to avoid thundering herd / flaky concurrent cookie client usage
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index];
    const result = await loadKanbanColumnCards(supabase, {
      ...filters,
      tagId: tag.id,
      offset: 0,
      includeUntagged: index === 0,
    });
    hasMoreByTag[tag.id] = result.hasMore;
    offsetByTag[tag.id] = result.nextOffset;
    cards.push(...result.cards);
  }

  return { cards, hasMoreByTag, offsetByTag };
}
