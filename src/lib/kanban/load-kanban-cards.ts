import { getSystemDb } from "@/lib/db/client";
import {
  listKanbanCardRows,
  listKanbanColumnIds,
  listTaggedConversationIds,
  listUntaggedConversationIds,
  searchKanbanContactIds,
  type KanbanConversationFilters,
} from "@/lib/db/repos/kanban";
import type { Db } from "@/lib/db/types";
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
  admin: Db,
  companyId: string,
  q: string,
): Promise<string[] | null> {
  const search = q.trim();
  if (!search) return null;
  const pattern = ilikePattern(search);
  const { data: contacts, error } = await searchKanbanContactIds(
    admin,
    companyId,
    pattern,
  );
  if (error) throw new Error(`Kanban search contacts: ${error.message}`);
  return (contacts ?? []).map((c) => c.id as string);
}

/**
 * Column lookups run with the service role and only ever yield ids: with RLS a
 * column scanned thousands of rows and hit the 8s timeout. The cards themselves
 * are then read with the user's client, so RLS still decides what they can see.
 */
export async function loadKanbanColumnCards(
  db: Db,
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

  const admin = getSystemDb();
  const searchContactIds = await resolveSearchContactIds(
    admin,
    filters.companyId,
    filters.q ?? "",
  );
  const searchPattern = (filters.q ?? "").trim()
    ? ilikePattern(filters.q!.trim())
    : null;

  const conversationFilters: KanbanConversationFilters = {
    inboxId: filters.inboxId,
    assignee: filters.assignee,
    userId: filters.userId,
    searchPattern,
    searchContactIds,
  };

  const { data: taggedIds, error: taggedErr } = await listTaggedConversationIds(
    admin,
    filters.companyId,
    filters.tagId,
    conversationFilters,
    from,
    to,
  );
  if (taggedErr) throw new Error(`Kanban tagged: ${taggedErr.message}`);

  let untaggedIds: Array<{ id: unknown }> = [];
  if (filters.includeUntagged) {
    const { data: kanbanTags, error: tagsErr } = await listKanbanColumnIds(
      admin,
      filters.companyId,
    );
    if (tagsErr) throw new Error(`Kanban tags: ${tagsErr.message}`);

    // Anti-join: conversations with no link to any of this company's columns.
    const { data, error: untaggedErr } = await listUntaggedConversationIds(
      admin,
      filters.companyId,
      (kanbanTags ?? []).map((t) => t.id as string),
      conversationFilters,
      from,
      to,
    );
    if (untaggedErr) throw new Error(`Kanban untagged: ${untaggedErr.message}`);
    untaggedIds = data ?? [];
  }

  const ids = [...(taggedIds ?? []), ...untaggedIds].map((r) => r.id as string);
  const { data: rows, error: rowsErr } = ids.length
    ? await listKanbanCardRows(db, ids)
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
  db: Db,
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
      loadKanbanColumnCards(db, {
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
