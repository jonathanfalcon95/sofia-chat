import { createClient } from "@/lib/supabase/server";
import { listCompanyAgents } from "@/lib/agents";
import { CONVERSATION_LIST_SELECT, MESSAGE_PAGE_SIZE } from "./types";
import { normalizeConversations, normalizeNotes } from "./normalize";
import type { MessageRow } from "./types";

export async function loadInboxBootstrap(conversationId?: string) {
  const supabase = await createClient();

  const conversationQuery = supabase
    .from("conversations")
    .select(CONVERSATION_LIST_SELECT)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100);

  const messagesQuery = conversationId
    ? supabase
        .from("messages")
        .select(
          "id, direction, type, body, status, created_at, template_name, conversation_id",
        )
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(MESSAGE_PAGE_SIZE)
    : Promise.resolve({ data: null as MessageRow[] | null });

  const notesQuery = conversationId
    ? supabase
        .from("conversation_notes")
        .select("id, body, created_at, profiles(full_name, email)")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
    : Promise.resolve({ data: null });

  const [
    { data: conversations },
    agents,
    { data: tags },
    { data: contactTags },
    { data: inboxes },
    { data: messageRows },
    { data: noteRows },
  ] = await Promise.all([
    conversationQuery,
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
    supabase
      .from("inboxes")
      .select("id, name, phone_number, company_id")
      .eq("is_active", true),
    messagesQuery,
    notesQuery,
  ]);

  const initialMessages = conversationId
    ? (((messageRows as MessageRow[] | null) ?? []).slice().reverse())
    : [];

  return {
    conversations: normalizeConversations(
      conversations as Array<Record<string, unknown>> | null,
    ),
    agents,
    tags: tags ?? [],
    contactTags: contactTags ?? [],
    inboxes: inboxes ?? [],
    initialMessages,
    initialNotes: conversationId
      ? normalizeNotes(noteRows as Array<Record<string, unknown>> | null)
      : [],
    hasMoreMessages: Boolean(
      conversationId && (messageRows?.length ?? 0) >= MESSAGE_PAGE_SIZE,
    ),
  };
}
