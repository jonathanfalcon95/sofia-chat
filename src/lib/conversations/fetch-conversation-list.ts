import type { SupabaseClient } from "@supabase/supabase-js";
import { ilikePattern } from "@/lib/pagination";
import { normalizeConversations } from "./normalize";
import {
  CONVERSATION_LIST_SELECT,
  CONVERSATION_PAGE_SIZE,
  type AssigneeFilter,
  type ConversationRow,
} from "./types";

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
  supabase: SupabaseClient,
  phoneSearch: string,
): Promise<{ contactIds: string[] | null; empty: boolean }> {
  const query = phoneSearch.trim().toLowerCase();
  const digits = phoneSearch.replace(/\D/g, "");
  if (!query && !digits) return { contactIds: null, empty: false };

  const pattern = ilikePattern(query || digits);
  const orParts = [`name.ilike."${pattern}"`, `phone_number.ilike."${pattern}"`];
  if (digits && digits !== query) {
    orParts.push(`phone_number.ilike."%${digits.replace(/[%_,."'\\()]/g, "")}%"`);
  }

  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .or(orParts.join(","))
    .limit(500);
  if (error) throw new Error(`Conversation search: ${error.message}`);
  const contactIds = (data ?? []).map((c) => c.id as string);
  return { contactIds, empty: contactIds.length === 0 };
}

async function resolveTagContactIds(
  supabase: SupabaseClient,
  contactTagId: string,
): Promise<{ contactIds: string[]; empty: boolean }> {
  const { data, error } = await supabase
    .from("contact_tags")
    .select("contact_id")
    .eq("tag_id", contactTagId)
    .limit(2000);
  if (error) throw new Error(`Conversation tag filter: ${error.message}`);
  const contactIds = [
    ...new Set((data ?? []).map((r) => r.contact_id as string)),
  ];
  return { contactIds, empty: contactIds.length === 0 };
}

/**
 * Shared paginated conversation list query for SSR and client reload/load-more.
 */
export async function fetchConversationListPage(
  supabase: SupabaseClient,
  filters: ConversationListFilters = {},
): Promise<ConversationListPage> {
  const pageSize = filters.pageSize ?? CONVERSATION_PAGE_SIZE;

  let contactIdsFilter: string[] | null = null;

  if (filters.contactTagId) {
    const tagged = await resolveTagContactIds(supabase, filters.contactTagId);
    if (tagged.empty) return { conversations: [], hasMore: false };
    contactIdsFilter = tagged.contactIds;
  }

  if (filters.phoneSearch?.trim()) {
    const searched = await resolveSearchContactIds(
      supabase,
      filters.phoneSearch,
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

  let query = supabase
    .from("conversations")
    .select(CONVERSATION_LIST_SELECT)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(pageSize + 1);

  if (filters.assigneeId) {
    query = query.eq("assignee_id", filters.assigneeId);
  } else if (filters.assignee === "mine" && filters.currentUserId) {
    query = query.eq("assignee_id", filters.currentUserId);
  } else if (filters.assignee === "unassigned") {
    query = query.is("assignee_id", null);
  }

  if (contactIdsFilter) {
    query = query.in("contact_id", contactIdsFilter);
  }

  if (filters.companyId) {
    query = query.eq("company_id", filters.companyId);
  }

  if (filters.before) {
    query = query.lt("last_message_at", filters.before);
  }

  const { data, error } = await query;
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

/** Merge a refreshed first page into an already-loaded list without dropping older pages. */
export function mergeConversationListPage(
  prev: ConversationRow[],
  firstPage: ConversationRow[],
): ConversationRow[] {
  const firstIds = new Set(firstPage.map((c) => c.id));
  const older = prev.filter((c) => !firstIds.has(c.id));
  return [...firstPage, ...older];
}

/** Append a page of older conversations, skipping duplicates. */
export function appendConversationListPage(
  prev: ConversationRow[],
  nextPage: ConversationRow[],
): ConversationRow[] {
  const seen = new Set(prev.map((c) => c.id));
  const appended = nextPage.filter((c) => !seen.has(c.id));
  return [...prev, ...appended];
}
