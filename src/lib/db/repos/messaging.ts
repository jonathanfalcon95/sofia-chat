import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/messaging";
import type { Db } from "../types";

export const ENRICHABLE_MESSAGE_SELECT =
  "id, type, body, conversation_id, created_at";

/** Conversation with the phones needed to send to it. Errors when there is no such row. */
export async function getConversationForSending(
  db: Db,
  conversationId: string,
) {
  if (isSqlDb(db)) return sql.getConversationForSending(db, conversationId);

  return db
    .from("conversations")
    .select(
      `
      id, company_id, window_expires_at, inbox_id,
      inboxes ( phone_number ),
      contacts ( phone_number )
    `,
    )
    .eq("id", conversationId)
    .single();
}

export async function getConversationForSofia(
  db: Db,
  conversationId: string,
) {
  if (isSqlDb(db)) return sql.getConversationForSofia(db, conversationId);

  return db
    .from("conversations")
    .select(
      `
      id, company_id, inbox_id,
      inboxes ( phone_number, ycloud_account_id ),
      contacts ( phone_number, name )
    `,
    )
    .eq("id", conversationId)
    .single();
}

/** Errors when the conversation doesn't exist; see findConversationInbox. */
export async function getConversationInbox(db: Db, conversationId: string) {
  if (isSqlDb(db)) return sql.getConversationInbox(db, conversationId);

  return db
    .from("conversations")
    .select("inbox_id")
    .eq("id", conversationId)
    .single();
}

export async function findConversationInbox(db: Db, conversationId: string) {
  if (isSqlDb(db)) return sql.findConversationInbox(db, conversationId);

  return db
    .from("conversations")
    .select("inbox_id")
    .eq("id", conversationId)
    .maybeSingle();
}

export async function findInboxId(db: Db, inboxId: string) {
  if (isSqlDb(db)) return sql.findInboxId(db, inboxId);

  return db.from("inboxes").select("id").eq("id", inboxId).maybeSingle();
}

export async function findCompanyGuid(db: Db, companyId: string) {
  if (isSqlDb(db)) return sql.findCompanyGuid(db, companyId);

  return db
    .from("companies")
    .select("guid_company")
    .eq("id", companyId)
    .maybeSingle();
}

/** Stores a message and returns the stored row. */
export async function insertMessage(db: Db, row: Record<string, unknown>) {
  if (isSqlDb(db)) return sql.insertMessage(db, row);

  return db.from("messages").insert(row).select("*").single();
}

export async function updateConversationLastMessage(
  db: Db,
  conversationId: string,
  patch: Record<string, unknown>,
) {
  if (isSqlDb(db)) return sql.updateConversationLastMessage(db, conversationId, patch);

  return db.from("conversations").update(patch).eq("id", conversationId);
}

export async function getMessageForReaction(
  db: Db,
  messageId: string,
  conversationId: string,
) {
  if (isSqlDb(db)) return sql.getMessageForReaction(db, messageId, conversationId);

  return db
    .from("messages")
    .select("id, wamid, ycloud_message_id, reactions")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();
}

export async function updateMessageReactions(
  db: Db,
  messageId: string,
  reactions: unknown[],
) {
  if (isSqlDb(db)) return sql.updateMessageReactions(db, messageId, reactions);

  return db
    .from("messages")
    .update({ reactions })
    .eq("id", messageId)
    .select("*")
    .single();
}

export async function updateMessagesMediaByYCloudIds(
  db: Db,
  ycloudMessageIds: string[],
  patch: Record<string, unknown>,
) {
  if (isSqlDb(db)) return sql.updateMessagesMediaByYCloudIds(db, ycloudMessageIds, patch);

  return db
    .from("messages")
    .update(patch)
    .in("ycloud_message_id", ycloudMessageIds);
}

export async function listEnrichableMessagesByYCloudIds(
  db: Db,
  ycloudMessageIds: string[],
) {
  if (isSqlDb(db)) return sql.listEnrichableMessagesByYCloudIds(db, ycloudMessageIds);

  return db
    .from("messages")
    .select(ENRICHABLE_MESSAGE_SELECT)
    .in("ycloud_message_id", ycloudMessageIds)
    .limit(1);
}

/** Writes only if the row still holds `currentBody`. */
export async function updateMessageBodyIfUnchanged(
  db: Db,
  messageId: string,
  currentBody: string,
  patch: Record<string, unknown>,
) {
  if (isSqlDb(db)) return sql.updateMessageBodyIfUnchanged(db, messageId, currentBody, patch);

  return db
    .from("messages")
    .update(patch)
    .eq("id", messageId)
    .eq("body", currentBody);
}

/** Writes only if the preview is still `currentPreview` and no later message arrived. */
export async function updateConversationPreviewIfUnchanged(
  db: Db,
  conversationId: string,
  preview: string,
  currentPreview: string,
  messageCreatedAt: string,
) {
  if (isSqlDb(db)) return sql.updateConversationPreviewIfUnchanged(db, conversationId, preview, currentPreview, messageCreatedAt);

  return db
    .from("conversations")
    .update({ last_message_preview: preview })
    .eq("id", conversationId)
    .eq("last_message_preview", currentPreview)
    .lte("last_message_at", messageCreatedAt);
}
