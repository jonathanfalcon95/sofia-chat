import { createClient } from "@/lib/supabase/server";
import { listCompanyAgents } from "@/lib/agents";
import { MESSAGE_PAGE_SIZE, MESSAGE_SELECT } from "./types";
import { normalizeNotes } from "./normalize";
import type { MessageRow } from "./types";
import { nowMs, reportServerDuration } from "./perf";
import { fetchConversationListPage } from "./fetch-conversation-list";

export async function loadInboxListData() {
  const startedAt = nowMs();
  const supabase = await createClient();
  const conversationQueryStartedAt = nowMs();

  const [
    listPage,
    agents,
    { data: tags },
    { data: contactTags },
  ] = await Promise.all([
    fetchConversationListPage(supabase),
    listCompanyAgents(),
    supabase
      .from("tags")
      .select("id, name, color, company_id")
      .eq("is_kanban_column", true)
      .order("position"),
    supabase
      .from("tags")
      .select("id, name, color, company_id")
      .eq("is_kanban_column", false)
      .order("name"),
  ]);

  reportServerDuration("list_query", conversationQueryStartedAt, {
    rows: listPage.conversations.length,
    hasMore: listPage.hasMore,
  });
  reportServerDuration("list_bootstrap_total", startedAt, {
    conversations: listPage.conversations.length,
    agents: agents.length,
    tags: (tags?.length ?? 0) + (contactTags?.length ?? 0),
  });

  return {
    conversations: listPage.conversations,
    hasMoreConversations: listPage.hasMore,
    agents,
    tags: tags ?? [],
    contactTags: contactTags ?? [],
    inboxes: [],
  };
}

export async function loadConversationDetailData(
  conversationId: string,
  options?: { includeNotes?: boolean },
) {
  const startedAt = nowMs();
  const supabase = await createClient();
  const includeNotes = options?.includeNotes ?? false;

  const messagesStartedAt = nowMs();
  const messagesQuery = supabase
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", conversationId)
    .neq("type", "reaction")
    .order("created_at", { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);

  const notesQuery = includeNotes
    ? supabase
        .from("conversation_notes")
        .select("id, body, created_at, profiles(full_name, email)")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
    : Promise.resolve({ data: [] as Array<Record<string, unknown>> });

  const [{ data: messageRows }, { data: noteRows }] = await Promise.all([
    messagesQuery,
    notesQuery,
  ]);
  reportServerDuration("detail_messages_query", messagesStartedAt, {
    conversationId,
    rows: messageRows?.length ?? 0,
  });
  reportServerDuration("detail_total", startedAt, {
    conversationId,
    includeNotes,
    notes: noteRows?.length ?? 0,
  });

  return {
    initialMessages: ((messageRows as MessageRow[] | null) ?? []).slice().reverse(),
    initialNotes: includeNotes
      ? normalizeNotes(noteRows as Array<Record<string, unknown>> | null)
      : [],
    hasMoreMessages: (messageRows?.length ?? 0) >= MESSAGE_PAGE_SIZE,
  };
}

export async function loadInboxBootstrap(conversationId?: string) {
  const [listData, detailData] = await Promise.all([
    loadInboxListData(),
    conversationId
      ? loadConversationDetailData(conversationId, { includeNotes: true })
      : Promise.resolve({
          initialMessages: [] as MessageRow[],
          initialNotes: [],
          hasMoreMessages: false,
        }),
  ]);

  return {
    ...listData,
    ...detailData,
  };
}
