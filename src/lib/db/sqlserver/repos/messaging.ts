import { hasInboxAccess, hasPermission, scope, type Access } from "../access";
import { accessOf, done, type SqlDb } from "../db";
import { isUuid, raw, sql, where, type SqlFragment } from "../sql";
import {
  insertStatement,
  maybeOne,
  messageVisible,
  one,
  outputInserted,
  rlsViolation,
  rows,
  setClause,
  utc,
  type WritableTable,
} from "./shared";

const MESSAGE_COLUMNS = [
  "id",
  "conversation_id",
  "company_id",
  "direction",
  "type",
  "body",
  "template_name",
  "template_language",
  "template_components",
  "ycloud_message_id",
  "status",
  "media_url",
  "raw_payload",
  "sent_by",
  "created_at",
  "media_mime",
  "media_filename",
  "media_sha256",
  "wamid",
  "reply_to_wamid",
  "reactions",
];

const MESSAGES: WritableTable = {
  name: "chatbase.messages",
  columns: MESSAGE_COLUMNS,
  json: ["template_components", "raw_payload", "reactions"],
  timestamps: ["created_at"],
};

const CONVERSATIONS: WritableTable = {
  name: "chatbase.conversations",
  columns: [
    "id",
    "company_id",
    "inbox_id",
    "contact_id",
    "assignee_id",
    "status",
    "last_message_at",
    "last_inbound_at",
    "window_expires_at",
    "last_message_preview",
    "unread_count",
    "created_at",
    "updated_at",
  ],
  timestamps: [
    "last_message_at",
    "last_inbound_at",
    "window_expires_at",
    "created_at",
    "updated_at",
  ],
  touchesUpdatedAt: true,
};

function readableConversation(access: Access | null, inboxColumn: string) {
  return access ? scope.conversationsRead(access, inboxColumn) : null;
}

function joinedInbox(access: Access | null) {
  return access ? sql`AND ${scope.inboxesRead(access, "i.id", "i.company_id")}` : raw("");
}

function joinedContact(access: Access | null) {
  return access ? sql`AND ${scope.company(access, "ct.company_id")}` : raw("");
}

/**
 * Exact comparison for the compare-and-swap writes. `=` here ignores case by the column's collation
 * and trailing spaces by SQL rules, while Postgres compared the text as it was.
 */
function sameText(column: string, value: string) {
  return sql`CAST(${raw(column)} AS varbinary(max)) = CAST(${value} AS varbinary(max))`;
}

/**
 * `col IN (...)` for ycloud_message_id. Its collation is written out: an OPENJSON value carries the
 * database's, and comparing the two raises a collation conflict.
 */
function ycloudIdList(ids: string[]) {
  return sql`(SELECT CAST([value] AS nvarchar(4000)) COLLATE Latin1_General_100_BIN2
              FROM OPENJSON(${JSON.stringify(ids)}))`;
}

/** Conversation with the phones needed to send to it. Errors when there is no such row. */
export async function getConversationForSending(db: SqlDb, conversationId: string) {
  return one(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT c.id, c.company_id, c.window_expires_at, c.inbox_id,
        i.id AS embedded_inbox_id, i.phone_number AS embedded_inbox_phone_number,
        ct.id AS embedded_contact_id, ct.phone_number AS embedded_contact_phone_number
      FROM chatbase.conversations c
      LEFT JOIN chatbase.inboxes i ON i.id = c.inbox_id ${joinedInbox(access)}
      LEFT JOIN chatbase.contacts ct ON ct.id = c.contact_id ${joinedContact(access)}
      ${where([sql`c.id = ${conversationId}`, readableConversation(access, "c.inbox_id")])}`);
    return found.map((row) => ({
      id: row.id,
      company_id: row.company_id,
      window_expires_at: row.window_expires_at,
      inbox_id: row.inbox_id,
      inboxes: row.embedded_inbox_id
        ? { phone_number: row.embedded_inbox_phone_number }
        : null,
      contacts: row.embedded_contact_id
        ? { phone_number: row.embedded_contact_phone_number }
        : null,
    }));
  });
}

export async function getConversationForSofia(db: SqlDb, conversationId: string) {
  return one(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT c.id, c.company_id, c.inbox_id,
        i.id AS embedded_inbox_id, i.phone_number AS embedded_inbox_phone_number,
        i.ycloud_account_id AS embedded_inbox_ycloud_account_id,
        ct.id AS embedded_contact_id, ct.phone_number AS embedded_contact_phone_number,
        ct.name AS embedded_contact_name
      FROM chatbase.conversations c
      LEFT JOIN chatbase.inboxes i ON i.id = c.inbox_id ${joinedInbox(access)}
      LEFT JOIN chatbase.contacts ct ON ct.id = c.contact_id ${joinedContact(access)}
      ${where([sql`c.id = ${conversationId}`, readableConversation(access, "c.inbox_id")])}`);
    return found.map((row) => ({
      id: row.id,
      company_id: row.company_id,
      inbox_id: row.inbox_id,
      inboxes: row.embedded_inbox_id
        ? {
            phone_number: row.embedded_inbox_phone_number,
            ycloud_account_id: row.embedded_inbox_ycloud_account_id,
          }
        : null,
      contacts: row.embedded_contact_id
        ? { phone_number: row.embedded_contact_phone_number, name: row.embedded_contact_name }
        : null,
    }));
  });
}

async function selectConversationInbox(db: SqlDb, conversationId: string) {
  if (!isUuid(conversationId)) return [];
  const access = await accessOf(db);
  return db.run(sql`
    SELECT inbox_id FROM chatbase.conversations
    ${where([sql`id = ${conversationId}`, readableConversation(access, "inbox_id")])}`);
}

/** Errors when the conversation doesn't exist; see findConversationInbox. */
export async function getConversationInbox(db: SqlDb, conversationId: string) {
  return one(() => selectConversationInbox(db, conversationId));
}

export async function findConversationInbox(db: SqlDb, conversationId: string) {
  return maybeOne(() => selectConversationInbox(db, conversationId));
}

export async function findInboxId(db: SqlDb, inboxId: string) {
  return maybeOne(async () => {
    if (!isUuid(inboxId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id FROM chatbase.inboxes
      ${where([
        sql`id = ${inboxId}`,
        access ? scope.inboxesRead(access, "id", "company_id") : null,
      ])}`);
  });
}

export async function findCompanyGuid(db: SqlDb, companyId: string) {
  return maybeOne(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT guid_company FROM chatbase.companies
      ${where([sql`id = ${companyId}`, access ? scope.company(access, "id") : null])}`);
  });
}

/** A point in time from a webhook payload, or null where Postgres' timestamptz cast failed. */
function parsePayloadTime(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const time = utc(value.trim());
  return Number.isNaN(new Date(time).getTime()) ? null : time;
}

/** Port of the messages_apply_send_time trigger: echoes keep the time they were really sent. */
function applySendTime(row: Record<string, unknown>) {
  if (row.direction !== "outbound" || row.sent_by != null) return row;
  const payload = row.raw_payload;
  if (typeof payload !== "object" || payload === null) return row;
  const { sendTime, createTime } = payload as Record<string, unknown>;
  const sent = parsePayloadTime(sendTime) ?? parsePayloadTime(createTime);
  return sent ? { ...row, created_at: sent } : row;
}

/** WITH CHECK of messages_insert and messages_update, on the conversation the row points to. */
async function checkConversationWritable(
  db: SqlDb,
  access: Access,
  conversationId: unknown,
  permission?: string,
) {
  const found = isUuid(conversationId)
    ? await db.run(sql`
        SELECT inbox_id, company_id FROM chatbase.conversations WHERE id = ${conversationId}`)
    : [];
  const conversation = found[0];
  const allowed =
    conversation &&
    hasInboxAccess(access, conversation.inbox_id as string) &&
    (!permission || hasPermission(access, conversation.company_id as string, permission));
  if (!allowed) throw rlsViolation();
}

/** Stores a message and returns the stored row. */
export async function insertMessage(db: SqlDb, row: Record<string, unknown>) {
  return one(async () => {
    const access = await accessOf(db);
    if (access) {
      await checkConversationWritable(db, access, row.conversation_id, "conversations.reply");
    }
    return db.run(insertStatement(MESSAGES, applySendTime(row), MESSAGE_COLUMNS));
  });
}

export async function updateConversationLastMessage(
  db: SqlDb,
  conversationId: string,
  patch: Record<string, unknown>,
) {
  return done(async () => {
    if (!isUuid(conversationId)) return;
    const access = await accessOf(db);
    // WITH CHECK of conversations_update: a conversation can't move to an unreachable inbox.
    if (
      access &&
      patch.inbox_id !== undefined &&
      !hasInboxAccess(access, patch.inbox_id as string | null)
    ) {
      throw rlsViolation();
    }
    const set = setClause(CONVERSATIONS, patch);
    if (!set) return;
    await db.run(sql`
      UPDATE chatbase.conversations SET ${set}
      ${where([
        sql`id = ${conversationId}`,
        access ? scope.inbox(access, "inbox_id") : null,
      ])}`);
  });
}

export async function getMessageForReaction(
  db: SqlDb,
  messageId: string,
  conversationId: string,
) {
  return one(async () => {
    if (!isUuid(messageId) || !isUuid(conversationId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT m.id, m.wamid, m.ycloud_message_id, m.reactions
      FROM chatbase.messages m
      ${where([
        sql`m.id = ${messageId}`,
        sql`m.conversation_id = ${conversationId}`,
        access ? messageVisible(access, "m.conversation_id") : null,
      ])}`);
  });
}

export async function updateMessageReactions(
  db: SqlDb,
  messageId: string,
  reactions: unknown[],
) {
  return one(async () => {
    if (!isUuid(messageId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      UPDATE m SET reactions = ${JSON.stringify(reactions)}
      ${outputInserted(MESSAGE_COLUMNS)}
      FROM chatbase.messages m
      ${where([
        sql`m.id = ${messageId}`,
        access ? messageVisible(access, "m.conversation_id") : null,
      ])}`);
  });
}

/** A patched message: the access condition plus the WITH CHECK when the patch moves it. */
async function updateMessages(
  db: SqlDb,
  patch: Record<string, unknown>,
  conditions: SqlFragment[],
) {
  const access = await accessOf(db);
  if (access && patch.conversation_id !== undefined) {
    await checkConversationWritable(db, access, patch.conversation_id);
  }
  const set = setClause(MESSAGES, patch);
  if (!set) return;
  await db.run(sql`
    UPDATE m SET ${set}
    FROM chatbase.messages m
    ${where([...conditions, access ? messageVisible(access, "m.conversation_id") : null])}`);
}

export async function updateMessagesMediaByYCloudIds(
  db: SqlDb,
  ycloudMessageIds: string[],
  patch: Record<string, unknown>,
) {
  return done(() =>
    updateMessages(db, patch, [sql`m.ycloud_message_id IN ${ycloudIdList(ycloudMessageIds)}`]),
  );
}

export async function listEnrichableMessagesByYCloudIds(
  db: SqlDb,
  ycloudMessageIds: string[],
) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (1) m.id, m.type, m.body, m.conversation_id, m.created_at
      FROM chatbase.messages m
      ${where([
        sql`m.ycloud_message_id IN ${ycloudIdList(ycloudMessageIds)}`,
        access ? messageVisible(access, "m.conversation_id") : null,
      ])}`);
  });
}

/** Writes only if the row still holds `currentBody`. */
export async function updateMessageBodyIfUnchanged(
  db: SqlDb,
  messageId: string,
  currentBody: string,
  patch: Record<string, unknown>,
) {
  return done(async () => {
    if (!isUuid(messageId)) return;
    await updateMessages(db, patch, [
      sql`m.id = ${messageId}`,
      sameText("m.body", currentBody),
    ]);
  });
}

/** Writes only if the preview is still `currentPreview` and no later message arrived. */
export async function updateConversationPreviewIfUnchanged(
  db: SqlDb,
  conversationId: string,
  preview: string,
  currentPreview: string,
  messageCreatedAt: string,
) {
  return done(async () => {
    if (!isUuid(conversationId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.conversations
      SET last_message_preview = ${preview}, updated_at = SYSUTCDATETIME()
      ${where([
        sql`id = ${conversationId}`,
        sameText("last_message_preview", currentPreview),
        sql`last_message_at <= ${utc(messageCreatedAt)}`,
        access ? scope.inbox(access, "inbox_id") : null,
      ])}`);
  });
}
