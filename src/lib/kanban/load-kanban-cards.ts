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

async function applyCommonFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  supabase: SupabaseClient,
  filters: KanbanLoadFilters,
) {
  let q = query.eq("company_id", filters.companyId);
  if (filters.inboxId) q = q.eq("inbox_id", filters.inboxId);
  if (filters.assignee === "mine" && filters.userId) {
    q = q.eq("assignee_id", filters.userId);
  } else if (filters.assignee === "unassigned") {
    q = q.is("assignee_id", null);
  }

  const search = (filters.q ?? "").trim();
  if (search) {
    const pattern = ilikePattern(search);
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id")
      .eq("company_id", filters.companyId)
      .or(`name.ilike."${pattern}",phone_number.ilike."${pattern}"`);
    const contactIds = (contacts ?? []).map((c) => c.id as string);
    if (contactIds.length > 0) {
      q = q.or(
        `contact_id.in.(${contactIds.join(",")}),last_message_preview.ilike."${pattern}"`,
      );
    } else {
      q = q.ilike("last_message_preview", pattern);
    }
  }

  return q;
}

const CONV_SELECT = `
  id, last_message_preview, last_message_at, inbox_id, company_id, contact_id, assignee_id,
  contacts ( id, name, phone_number ),
  inboxes ( name )
`;

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
  // Over-fetch to absorb contact dedupe
  const fetchSize = pageSize * 2;
  const from = offset;
  const to = offset + fetchSize - 1;

  let taggedQuery = supabase
    .from("conversations")
    .select(
      `${CONV_SELECT}, conversation_tags!inner ( tag_id )`,
    )
    .eq("conversation_tags.tag_id", filters.tagId)
    .order("last_message_at", { ascending: false, nullsFirst: false });

  taggedQuery = await applyCommonFilters(taggedQuery, supabase, filters);
  const { data: taggedRows } = await taggedQuery.range(from, to);

  let cards = dedupeByContact(
    (taggedRows ?? [])
      .map((row) => mapCard(row as ConvRow, filters.tagId))
      .filter((c): c is KanbanCard => Boolean(c)),
  );

  if (filters.includeUntagged) {
    const { data: kanbanTags } = await supabase
      .from("tags")
      .select("id")
      .eq("company_id", filters.companyId)
      .eq("is_kanban_column", true);
    const kanbanTagIds = (kanbanTags ?? []).map((t) => t.id as string);

    let taggedConvIds: string[] = [];
    if (kanbanTagIds.length > 0) {
      const { data: links } = await supabase
        .from("conversation_tags")
        .select("conversation_id")
        .in("tag_id", kanbanTagIds)
        .limit(5000);
      taggedConvIds = [
        ...new Set((links ?? []).map((l) => l.conversation_id as string)),
      ];
    }

    let untaggedQuery = supabase
      .from("conversations")
      .select(CONV_SELECT)
      .order("last_message_at", { ascending: false, nullsFirst: false });
    untaggedQuery = await applyCommonFilters(untaggedQuery, supabase, filters);
    if (taggedConvIds.length > 0 && taggedConvIds.length <= 500) {
      untaggedQuery = untaggedQuery.not(
        "id",
        "in",
        `(${taggedConvIds.join(",")})`,
      );
    }
    const { data: untaggedRows } = await untaggedQuery.range(from, to);
    const untaggedCards = dedupeByContact(
      (untaggedRows ?? [])
        .map((row) => {
          // If we couldn't exclude via NOT IN (too many), filter client-side
          if (
            taggedConvIds.length > 500 &&
            taggedConvIds.includes(row.id as string)
          ) {
            return null;
          }
          return mapCard(row as ConvRow, filters.tagId);
        })
        .filter((c): c is KanbanCard => Boolean(c)),
    );

    const seen = new Set(cards.map((c) => c.contactId));
    for (const card of untaggedCards) {
      if (seen.has(card.contactId)) continue;
      seen.add(card.contactId);
      cards.push(card);
    }
  }

  const page = cards.slice(0, pageSize);
  const hasMore = cards.length > pageSize || (taggedRows?.length ?? 0) >= fetchSize;
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
  const defaultTagId = tags[0]?.id ?? null;
  const cards: KanbanCard[] = [];
  const hasMoreByTag: Record<string, boolean> = {};
  const offsetByTag: Record<string, number> = {};

  await Promise.all(
    tags.map(async (tag, index) => {
      const result = await loadKanbanColumnCards(supabase, {
        ...filters,
        tagId: tag.id,
        offset: 0,
        includeUntagged: index === 0 && Boolean(defaultTagId),
      });
      hasMoreByTag[tag.id] = result.hasMore;
      offsetByTag[tag.id] = result.nextOffset;
      cards.push(...result.cards);
    }),
  );

  return { cards, hasMoreByTag, offsetByTag };
}
