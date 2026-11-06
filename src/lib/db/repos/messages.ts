import {
  olderThanCursorFilter,
  type PageCursor,
} from "@/lib/conversations/page-cursor";
import { MESSAGE_PAGE_SIZE, MESSAGE_SELECT } from "@/lib/conversations/types";
import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/messages";
import type { Db } from "../types";

/** One page of a thread, newest first. `before` is the older-page cursor. */
export async function listConversationMessagesPage(
  db: Db,
  conversationId: string,
  before?: PageCursor | null,
) {
  if (isSqlDb(db)) return sql.listConversationMessagesPage(db, conversationId, before);

  let query = db
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", conversationId)
    .neq("type", "reaction");

  if (before) {
    query = query.or(olderThanCursorFilter("created_at", before));
  }

  return query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
}

/** Inbound messages strictly newer than this timestamp, oldest first. */
export async function listInboundMessagesAfter(db: Db, after: string) {
  if (isSqlDb(db)) return sql.listInboundMessagesAfter(db, after);

  return db
    .from("messages")
    .select("id, conversation_id, body, created_at, direction")
    .eq("direction", "inbound")
    .gt("created_at", after)
    .order("created_at", { ascending: true })
    .limit(20);
}
