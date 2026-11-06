import { cookies } from "next/headers";
import { getUserDb } from "@/lib/db/client";
import {
  listCompaniesByName,
  listContactTagOptions,
  listKanbanTagOptions,
} from "@/lib/db/repos/conversations";
import { listConversationMessagesPage } from "@/lib/db/repos/messages";
import { listConversationNotes } from "@/lib/db/repos/notes";
import type { Db } from "@/lib/db/types";
import { listCompanyAgents } from "@/lib/agents";
import { getAppSession } from "@/lib/rbac/session";
import { MESSAGE_PAGE_SIZE } from "./types";
import { normalizeNotes } from "./normalize";
import type { ConversationRow, MessageRow } from "./types";
import { nowMs, reportServerDuration } from "./perf";
import {
  fetchConversationById,
  fetchConversationListPage,
} from "./fetch-conversation-list";
import {
  INBOX_COMPANY_COOKIE,
  resolveInitialCompanyId,
} from "./inbox-company-preference";

export type InboxCompany = { id: string; name: string };

async function loadInitialListPage(db: Db, companyId: string) {
  try {
    const page = await fetchConversationListPage(db, { companyId });
    return { ...page, failed: false };
  } catch (err) {
    console.error("[inbox] conversation list bootstrap failed", err);
    return { conversations: [] as ConversationRow[], hasMore: false, failed: true };
  }
}

export async function loadInboxListData() {
  const startedAt = nowMs();
  const db = await getUserDb();
  const conversationQueryStartedAt = nowMs();

  const [session, { data: companies, error: companiesError }, cookieStore] =
    await Promise.all([getAppSession(), listCompaniesByName(db), cookies()]);

  if (companiesError) {
    console.error("[inbox] companies query failed", companiesError);
  }

  const companyList = (companies ?? []) as InboxCompany[];
  const showCompanyFilter =
    Boolean(session?.isPlatformAdmin) || companyList.length > 1;
  const initialCompanyId = resolveInitialCompanyId(
    companyList,
    cookieStore.get(INBOX_COMPANY_COOKIE)?.value,
  );

  const [listPage, agents, { data: tags }, { data: contactTags }] =
    await Promise.all([
      initialCompanyId
        ? loadInitialListPage(db, initialCompanyId)
        : Promise.resolve({
            conversations: [] as ConversationRow[],
            hasMore: false,
            failed: false,
          }),
      listCompanyAgents(),
      listKanbanTagOptions(db),
      listContactTagOptions(db),
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
    listLoadFailed: listPage.failed || Boolean(companiesError),
  };
}

export async function loadConversationDetailData(
  conversationId: string,
  options?: { includeNotes?: boolean },
) {
  const startedAt = nowMs();
  const db = await getUserDb();
  const includeNotes = options?.includeNotes ?? false;

  const messagesStartedAt = nowMs();
  const messagesQuery = listConversationMessagesPage(db, conversationId);

  const notesQuery = includeNotes
    ? listConversationNotes(db, conversationId)
    : Promise.resolve({ data: [] as Array<Record<string, unknown>> });

  const [
    { data: messageRows, error: messagesError },
    { data: noteRows },
    conversation,
  ] = await Promise.all([
    messagesQuery,
    notesQuery,
    fetchConversationById(db, conversationId),
  ]);
  if (messagesError) {
    throw new Error(`Conversation messages: ${messagesError.message}`);
  }
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
