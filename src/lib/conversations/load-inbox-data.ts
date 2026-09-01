import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { listCompanyAgents } from "@/lib/agents";
import { getAppSession } from "@/lib/rbac/session";
import { MESSAGE_PAGE_SIZE, MESSAGE_SELECT } from "./types";
import { normalizeNotes } from "./normalize";
import type { ConversationRow, MessageRow } from "./types";
import { nowMs, reportServerDuration } from "./perf";
import {
  fetchConversationById,
  fetchConversationListPage,
} from "./fetch-conversation-list";
import {
  INBOX_COMPANY_COOKIE,
  pickPreferredCompanyId,
} from "./inbox-company-preference";

export type InboxCompany = { id: string; name: string };

export async function loadInboxListData() {
  const startedAt = nowMs();
  const supabase = await createClient();
  const conversationQueryStartedAt = nowMs();

  const [session, { data: companies }, cookieStore] = await Promise.all([
    getAppSession(),
    supabase.from("companies").select("id, name").order("name"),
    cookies(),
  ]);

  const companyList = (companies ?? []) as InboxCompany[];
  const showCompanyFilter =
    Boolean(session?.isPlatformAdmin) || companyList.length > 1;
  const preferredCompanyId = pickPreferredCompanyId(
    companyList,
    cookieStore.get(INBOX_COMPANY_COOKIE)?.value,
  );
  const initialCompanyId = showCompanyFilter
    ? (preferredCompanyId ?? companyList[0]?.id ?? "")
    : "";

  let listPage = { conversations: [] as ConversationRow[], hasMore: false };
  if (!(showCompanyFilter && !initialCompanyId)) {
    try {
      listPage = await fetchConversationListPage(supabase, {
        companyId: initialCompanyId || undefined,
      });
    } catch (err) {
      console.error("[inbox] conversation list bootstrap failed", err);
    }
  }

  const [agents, { data: tags }, { data: contactTags }] = await Promise.all([
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
    companies: companyList,
    initialCompanyId,
    showCompanyFilter,
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

  const [{ data: messageRows }, { data: noteRows }, conversation] =
    await Promise.all([
      messagesQuery,
      notesQuery,
      fetchConversationById(supabase, conversationId),
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
    conversation: conversation as ConversationRow | null,
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
          conversation: null as ConversationRow | null,
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
