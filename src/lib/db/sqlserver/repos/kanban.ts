import type { KanbanConversationFilters } from "../../repos/kanban";
import { scope, type Access } from "../access";
import { accessOf, type SqlDb } from "../db";
import { isUuid, raw, sql, uuidList, where, type SqlFragment } from "../sql";
import { idsOf, listRows, visibleContacts, visibleInboxes } from "./conversation-embeds";

/**
 * The patterns reach this layer written for ILIKE, where `[` and `]` are literal and `\` escapes.
 * `%` and `_` mean the same in both.
 */
function likeFromIlike(pattern: string) {
  return pattern.replace(/\\([\s\S])|[[\]]/g, (match, escaped?: string) => `[${escaped ?? match}]`);
}

function assigneeOf(filters: KanbanConversationFilters) {
  return filters.assignee === "mine" ? filters.userId : undefined;
}

function filtersAreValid(filters: KanbanConversationFilters) {
  const assignee = assigneeOf(filters);
  return (
    (!filters.inboxId || isUuid(filters.inboxId)) &&
    (!assignee || isUuid(assignee)) &&
    (!filters.searchContactIds || filters.searchContactIds.every(isUuid))
  );
}

function conversationFilters(filters: KanbanConversationFilters): Array<SqlFragment | null> {
  const assignee = assigneeOf(filters);
  const pattern = filters.searchPattern ? likeFromIlike(filters.searchPattern) : null;
  return [
    filters.inboxId ? sql`c.inbox_id = ${filters.inboxId}` : null,
    assignee
      ? sql`c.assignee_id = ${assignee}`
      : filters.assignee === "unassigned"
        ? sql`c.assignee_id IS NULL`
        : null,
    pattern
      ? filters.searchContactIds?.length
        ? sql`(c.contact_id IN ${uuidList(filters.searchContactIds)} OR c.last_message_preview LIKE ${pattern})`
        : sql`c.last_message_preview LIKE ${pattern}`
      : null,
  ];
}

const PAGE_ORDER = raw("ORDER BY c.last_message_at DESC, c.id DESC");

function pageOf(from: number, to: number) {
  return sql`OFFSET ${from} ROWS FETCH NEXT ${to - from + 1} ROWS ONLY`;
}

/** conversations_select implies conversation_tags_select, so the tag links need no extra scope. */
function conversationScope(access: Access | null) {
  return access ? scope.conversationsRead(access, "c.inbox_id") : null;
}

export async function searchKanbanContactIds(db: SqlDb, companyId: string, pattern: string) {
  return listRows(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    const like = likeFromIlike(pattern);
    return db.run(sql`
      SELECT id FROM chatbase.contacts
      ${where([
        sql`company_id = ${companyId}`,
        sql`(name LIKE ${like} OR phone_number LIKE ${like})`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

export async function listTaggedConversationIds(
  db: SqlDb,
  companyId: string,
  tagId: string,
  filters: KanbanConversationFilters,
  from: number,
  to: number,
) {
  return listRows(async () => {
    if (!isUuid(companyId) || !isUuid(tagId) || !filtersAreValid(filters)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT c.id, ct.tag_id
      FROM chatbase.conversations c
      JOIN chatbase.conversation_tags ct ON ct.conversation_id = c.id
      ${where([
        sql`c.company_id = ${companyId}`,
        sql`ct.tag_id = ${tagId}`,
        ...conversationFilters(filters),
        conversationScope(access),
      ])}
      ${PAGE_ORDER}
      ${pageOf(from, to)}`);
    return found.map((row) => ({
      id: row.id,
      conversation_tags: [{ tag_id: row.tag_id }],
    }));
  });
}

export async function listKanbanColumnIds(db: SqlDb, companyId: string) {
  return listRows(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id FROM chatbase.tags
      ${where([
        sql`company_id = ${companyId}`,
        sql`is_kanban_column = 1`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

/** Anti-join: conversations with no link to any of these columns. */
export async function listUntaggedConversationIds(
  db: SqlDb,
  companyId: string,
  columnTagIds: string[],
  filters: KanbanConversationFilters,
  from: number,
  to: number,
) {
  return listRows(async () => {
    if (!isUuid(companyId) || !columnTagIds.every(isUuid) || !filtersAreValid(filters)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT c.id
      FROM chatbase.conversations c
      ${where([
        sql`c.company_id = ${companyId}`,
        sql`NOT EXISTS (SELECT 1 FROM chatbase.conversation_tags ct
                        WHERE ct.conversation_id = c.id AND ct.tag_id IN ${uuidList(columnTagIds)})`,
        ...conversationFilters(filters),
        conversationScope(access),
      ])}
      ${PAGE_ORDER}
      ${pageOf(from, to)}`);
    return found.map((row) => ({ id: row.id, conversation_tags: [] }));
  });
}

export async function listKanbanCardRows(db: SqlDb, conversationIds: string[]) {
  return listRows(async () => {
    if (!conversationIds.every(isUuid)) return [];
    const access = await accessOf(db);
    const conversations = await db.run(sql`
      SELECT c.id, c.last_message_preview, c.last_message_at, c.inbox_id, c.company_id,
             c.contact_id, c.assignee_id
      FROM chatbase.conversations c
      ${where([
        sql`c.id IN ${uuidList(conversationIds)}`,
        conversationScope(access),
      ])}
      ORDER BY c.last_message_at DESC`);
    const [contacts, inboxes] = await Promise.all([
      visibleContacts(db, access, idsOf(conversations, "contact_id")),
      visibleInboxes(db, access, idsOf(conversations, "inbox_id")),
    ]);
    return conversations.map((conversation) => {
      const contact = contacts.get(conversation.contact_id as string);
      const inbox = inboxes.get(conversation.inbox_id as string);
      return {
        ...conversation,
        contacts: contact
          ? { id: contact.id, name: contact.name, phone_number: contact.phone_number }
          : null,
        inboxes: inbox ? { name: inbox.name } : null,
      };
    });
  });
}

export async function listKanbanInboxes(db: SqlDb, companyId?: string) {
  return listRows(async () => {
    if (companyId && !isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name, company_id FROM chatbase.inboxes
      ${where([
        companyId ? sql`company_id = ${companyId}` : null,
        access ? scope.inboxesRead(access, "id", "company_id") : null,
      ])}`);
  });
}

export async function listKanbanColumns(db: SqlDb, companyId?: string) {
  return listRows(async () => {
    if (companyId && !isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name, color, position, company_id FROM chatbase.tags
      ${where([
        sql`is_kanban_column = 1`,
        companyId ? sql`company_id = ${companyId}` : null,
        access ? scope.company(access, "company_id") : null,
      ])}
      ORDER BY position`);
  });
}
