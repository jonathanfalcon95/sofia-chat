import type { Db } from "@/lib/db/types";
import {
  findConversationForList,
  listContactIdsByTag,
  listConversationsPage,
  searchContactIdsByNameOrPhone,
} from "@/lib/db/repos/conversations";
import { normalizeConversations } from "./normalize";
import {
  CONVERSATION_PAGE_SIZE,
  type AssigneeFilter,
  type ConversationRow,
} from "./types";
import {
  appendConversationListPage,
  mergeConversationListPage,
  upsertConversationInList,
} from "./conversation-list";

export type ConversationListFilters = {
  assignee?: AssigneeFilter;
  currentUserId?: string;
  /** Specific agent profile; takes precedence over mine/unassigned */
  assigneeId?: string;
  /** Free-text search over contact name / phone */
  phoneSearch?: string;
  contactTagId?: string;
  /** Restrict to one company (required for Super Admin / multi-empresa). */
  companyId?: string;
  /** Cursor: only rows strictly older than this ISO timestamp */
  before?: string | null;
  pageSize?: number;
};

export type ConversationListPage = {
  conversations: ConversationRow[];
  hasMore: boolean;
};

async function resolveSearchContactIds(
  db: Db,
  phoneSearch: string,
  companyId?: string,
): Promise<{ contactIds: string[] | null; empty: boolean }> {
  const query = phoneSearch.trim().toLowerCase();
  const digits = phoneSearch.replace(/\D/g, "");
  if (!query && !digits) return { contactIds: null, empty: false };

  const { data, error } = await searchContactIdsByNameOrPhone(
    db,
    query,
    digits,
    companyId,
  );
  if (error) throw new Error(`Conversation search: ${error.message}`);
  const contactIds = (data ?? []).map((c) => c.id as string);
  return { contactIds, empty: contactIds.length === 0 };
}

async function resolveTagContactIds(
  db: Db,
  contactTagId: string,
): Promise<{ contactIds: string[]; empty: boolean }> {
  const { data, error } = await listContactIdsByTag(db, contactTagId);
  if (error) throw new Error(`Conversation tag filter: ${error.message}`);
  const contactIds = [
    ...new Set((data ?? []).map((r) => r.contact_id as string)),
  ];
  return { contactIds, empty: contactIds.length === 0 };
}

/**
 * Shared paginated conversation list query for SSR and the /api/conversations
 * route the browser reloads and loads more through.
 */
export async function fetchConversationListPage(
  db: Db,
  filters: ConversationListFilters = {},
): Promise<ConversationListPage> {
  const pageSize = filters.pageSize ?? CONVERSATION_PAGE_SIZE;

  let contactIdsFilter: string[] | null = null;

  if (filters.contactTagId) {
    const tagged = await resolveTagContactIds(db, filters.contactTagId);
    if (tagged.empty) return { conversations: [], hasMore: false };
    contactIdsFilter = tagged.contactIds;
  }

  if (filters.phoneSearch?.trim()) {
    const searched = await resolveSearchContactIds(
      db,
      filters.phoneSearch,
      filters.companyId,
    );
    if (searched.empty) return { conversations: [], hasMore: false };
    if (searched.contactIds) {
      if (contactIdsFilter) {
        const allow = new Set(searched.contactIds);
        contactIdsFilter = contactIdsFilter.filter((id) => allow.has(id));
        if (contactIdsFilter.length === 0) {
          return { conversations: [], hasMore: false };
        }
      } else {
        contactIdsFilter = searched.contactIds;
      }
    }
  }

  const { data, error } = await listConversationsPage(db, {
    assignee: filters.assignee,
    currentUserId: filters.currentUserId,
    assigneeId: filters.assigneeId,
    contactIds: contactIdsFilter,
    companyId: filters.companyId,
    before: filters.before,
    limit: pageSize + 1,
  });
  if (error) throw new Error(`Conversation list: ${error.message}`);

  const rows = data ?? [];
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

  return {
    conversations: normalizeConversations(
      pageRows as Array<Record<string, unknown>>,
    ),
    hasMore,
  };
}

export {
  appendConversationListPage,
  mergeConversationListPage,
  upsertConversationInList,
};

/** Null means no such row (or no access); a failed query throws instead. */
export async function fetchConversationById(
  db: Db,
  conversationId: string,
): Promise<ConversationRow | null> {
  if (!conversationId) return null;
  const { data, error } = await findConversationForList(db, conversationId);
  if (error) throw new Error(`Conversation detail: ${error.message}`);
  if (!data) return null;
  return (
    normalizeConversations([data as Record<string, unknown>])[0] ?? null
  );
}
