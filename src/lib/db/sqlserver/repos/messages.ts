import type { PageCursor } from "@/lib/conversations/page-cursor";
import { MESSAGE_PAGE_SIZE, MESSAGE_SELECT } from "@/lib/conversations/types";
import { scope, type Access } from "../access";
import { accessOf, type SqlDb } from "../db";
import { isUuid, raw, sql, where } from "../sql";
import { listRows, olderThanCursor, utcTimestamp } from "./conversation-embeds";

/** messages_select: has_inbox_access through the conversation, with no conversations.view. */
function visibleToAccess(access: Access) {
  return sql`EXISTS (SELECT 1 FROM chatbase.conversations c
                     WHERE c.id = m.conversation_id AND ${scope.inbox(access, "c.inbox_id")})`;
}

/** One page of a thread, newest first. `before` is the older-page cursor. */
export async function listConversationMessagesPage(
  db: SqlDb,
  conversationId: string,
  before?: PageCursor | null,
) {
  return listRows(async () => {
    if (!isUuid(conversationId) || (before && !isUuid(before.id))) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (${MESSAGE_PAGE_SIZE}) ${raw(MESSAGE_SELECT)}
      FROM chatbase.messages m
      ${where([
        sql`m.conversation_id = ${conversationId}`,
        sql`m.type <> N'reaction'`,
        before ? olderThanCursor("m.created_at", "m.id", before) : null,
        access ? visibleToAccess(access) : null,
      ])}
      ORDER BY m.created_at DESC, m.id DESC`);
  });
}

/** Inbound messages strictly newer than this timestamp, oldest first. */
export async function listInboundMessagesAfter(db: SqlDb, after: string) {
  return listRows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (20) m.id, m.conversation_id, m.body, m.created_at, m.direction
      FROM chatbase.messages m
      ${where([
        sql`m.direction = N'inbound'`,
        sql`m.created_at > ${utcTimestamp(after)}`,
        access ? visibleToAccess(access) : null,
      ])}
      ORDER BY m.created_at ASC`);
  });
}
