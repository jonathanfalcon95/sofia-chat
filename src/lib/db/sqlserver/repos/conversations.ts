import { escapeIlike } from "@/lib/pagination";
import type { ConversationPageFilters } from "../../repos/conversations";
import { hasCompanyAccess, hasInboxAccess, hasPermission, scope, type Access } from "../access";
import type { Row } from "../connection";
import { accessOf, done, inTransaction, maybeOne, one, type SqlDb } from "../db";
import { containsPattern, isUuid, raw, sql, textList, uuidList, where } from "../sql";
import {
  idsOf,
  listRows,
  olderThanCursor,
  requireConversationPermission,
  rlsViolation,
  visibleContacts,
  visibleInboxes,
} from "./conversation-embeds";

const LIST_COLUMNS = raw(`c.id, c.company_id, c.inbox_id, c.status, c.last_message_at,
  c.last_message_preview, c.window_expires_at, c.assignee_id, c.unread_count, c.contact_id`);

function tagLink(row: Row) {
  return {
    tag_id: row.tag_id,
    tags: row.tag_row_id ? { id: row.tag_row_id, name: row.name, color: row.color } : null,
  };
}

/** The embeds of CONVERSATION_LIST_SELECT, one query per table. */
async function withListEmbeds(db: SqlDb, access: Access | null, conversations: Row[]) {
  if (!conversations.length) return [];
  const [contacts, inboxes, conversationTags] = await Promise.all([
    visibleContacts(db, access, idsOf(conversations, "contact_id")),
    visibleInboxes(db, access, idsOf(conversations, "inbox_id")),
    // These conversations passed conversations_select, which implies conversation_tags_select.
    db.run(sql`
      SELECT ct.conversation_id, ct.tag_id, t.id AS tag_row_id, t.name, t.color
      FROM chatbase.conversation_tags ct
      LEFT JOIN chatbase.tags t ON t.id = ct.tag_id
        ${access ? sql`AND ${scope.company(access, "t.company_id")}` : raw("")}
      WHERE ct.conversation_id IN ${uuidList(idsOf(conversations, "id"))}`),
  ]);
  // Only visible contacts: contact_tags_select is the same condition as contacts_select.
  const contactTags = contacts.size
    ? await db.run(sql`
        SELECT ct.contact_id, ct.tag_id, t.id AS tag_row_id, t.name, t.color
        FROM chatbase.contact_tags ct
        LEFT JOIN chatbase.tags t ON t.id = ct.tag_id
          ${access ? sql`AND ${scope.company(access, "t.company_id")}` : raw("")}
        WHERE ct.contact_id IN ${uuidList([...contacts.keys()])}`)
    : [];

  return conversations.map((conversation) => {
    const contact = contacts.get(conversation.contact_id as string);
    const inbox = inboxes.get(conversation.inbox_id as string);
    return {
      ...conversation,
      contacts: contact
        ? {
            id: contact.id,
            name: contact.name,
            phone_number: contact.phone_number,
            contact_tags: contactTags
              .filter((link) => link.contact_id === contact.id)
              .map(tagLink),
          }
        : null,
      inboxes: inbox ? { name: inbox.name } : null,
      conversation_tags: conversationTags
        .filter((link) => link.conversation_id === conversation.id)
        .map(tagLink),
    };
  });
}

export async function listConversationsPage(db: SqlDb, filters: ConversationPageFilters) {
  return listRows(async () => {
    const assigneeId =
      filters.assigneeId ||
      (filters.assignee === "mine" ? filters.currentUserId : undefined);
    const singleIds = [assigneeId, filters.companyId, filters.before?.id].filter(Boolean);
    if (!singleIds.every(isUuid) || (filters.contactIds && !filters.contactIds.every(isUuid))) {
      return [];
    }

    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT TOP (${filters.limit}) ${LIST_COLUMNS}
      FROM chatbase.conversations c
      ${where([
        assigneeId
          ? sql`c.assignee_id = ${assigneeId}`
          : filters.assignee === "unassigned"
            ? sql`c.assignee_id IS NULL`
            : null,
        filters.contactIds ? sql`c.contact_id IN ${uuidList(filters.contactIds)}` : null,
        filters.companyId ? sql`c.company_id = ${filters.companyId}` : null,
        filters.before ? olderThanCursor("c.last_message_at", "c.id", filters.before) : null,
        access ? scope.conversationsRead(access, "c.inbox_id") : null,
      ])}
      ORDER BY c.last_message_at DESC, c.id DESC`);
    return withListEmbeds(db, access, found);
  });
}

export async function findConversationForList(db: SqlDb, conversationId: string) {
  return maybeOne(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT ${LIST_COLUMNS}
      FROM chatbase.conversations c
      ${where([
        sql`c.id = ${conversationId}`,
        access ? scope.conversationsRead(access, "c.inbox_id") : null,
      ])}`);
    return withListEmbeds(db, access, found);
  });
}

/** `query` is the lowercased search text, `digits` only its numbers. */
export async function searchContactIdsByNameOrPhone(
  db: SqlDb,
  query: string,
  digits: string,
  companyId?: string,
) {
  return listRows(async () => {
    if (companyId && !isUuid(companyId)) return [];
    const access = await accessOf(db);
    // Same characters dropped as the PostgREST filter string, so both backends match the same rows.
    const pattern = containsPattern(escapeIlike(query || digits));
    const digitsPattern =
      digits && digits !== query
        ? containsPattern(digits.replace(/[%_,."'\\()]/g, ""))
        : null;
    return db.run(sql`
      SELECT TOP (500) id FROM chatbase.contacts
      ${where([
        sql`(name LIKE ${pattern} OR phone_number LIKE ${pattern}
          ${digitsPattern ? sql`OR phone_number LIKE ${digitsPattern}` : raw("")})`,
        companyId ? sql`company_id = ${companyId}` : null,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

export async function listContactIdsByTag(db: SqlDb, contactTagId: string) {
  return listRows(async () => {
    if (!isUuid(contactTagId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (2000) ct.contact_id
      FROM chatbase.contact_tags ct
      ${where([
        sql`ct.tag_id = ${contactTagId}`,
        access
          ? sql`EXISTS (SELECT 1 FROM chatbase.contacts c
                        WHERE c.id = ct.contact_id AND ${scope.company(access, "c.company_id")})`
          : null,
      ])}`);
  });
}

export async function markConversationRead(db: SqlDb, conversationId: string) {
  return done(async () => {
    if (!isUuid(conversationId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.conversations
      SET unread_count = 0, updated_at = SYSUTCDATETIME()
      ${where([
        sql`id = ${conversationId}`,
        sql`unread_count > 0`,
        access ? scope.inbox(access, "inbox_id") : null,
      ])}`);
  });
}

export async function findConversationAssignee(db: SqlDb, conversationId: string) {
  return maybeOne(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT assignee_id FROM chatbase.conversations
      ${where([
        sql`id = ${conversationId}`,
        access ? scope.conversationsRead(access, "inbox_id") : null,
      ])}`);
  });
}

export async function listConversationsAssignedTo(db: SqlDb, userId: string) {
  return listRows(async () => {
    if (!isUuid(userId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (500) id, assignee_id FROM chatbase.conversations
      ${where([
        sql`assignee_id = ${userId}`,
        access ? scope.conversationsRead(access, "inbox_id") : null,
      ])}`);
  });
}

export async function getConversationCompany(db: SqlDb, conversationId: string) {
  return one(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, company_id FROM chatbase.conversations
      ${where([
        sql`id = ${conversationId}`,
        access ? scope.conversationsRead(access, "inbox_id") : null,
      ])}`);
  });
}

export async function setConversationAssignee(
  db: SqlDb,
  conversationId: string,
  assigneeId: string | null,
) {
  return done(async () => {
    if (!isUuid(conversationId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.conversations
      SET assignee_id = ${assigneeId}, updated_at = SYSUTCDATETIME()
      ${where([
        sql`id = ${conversationId}`,
        access ? scope.inbox(access, "inbox_id") : null,
      ])}`);
  });
}

/** Active membership of this user in this company holding a role with this exact name. */
export async function findActiveMembershipWithRole(
  db: SqlDb,
  userId: string,
  companyId: string,
  roleName: string,
) {
  return maybeOne(async () => {
    if (!isUuid(userId) || !isUuid(companyId)) return [];
    const access = await accessOf(db);
    // roles.name is case-insensitive here; Postgres compared it exactly.
    const found = await db.run(sql`
      SELECT m.id, r.name
      FROM chatbase.company_memberships m
      JOIN chatbase.membership_roles mr ON mr.membership_id = m.id
      JOIN chatbase.roles r ON r.id = mr.role_id
      ${where([
        sql`m.user_id = ${userId}`,
        sql`m.company_id = ${companyId}`,
        sql`m.is_active = 1`,
        sql`r.name COLLATE Latin1_General_100_BIN2 = ${roleName}`,
        access ? scope.company(access, "m.company_id") : null,
        access ? scope.rolesRead(access, "r.company_id") : null,
      ])}`);
    // company_id + user_id is unique, so this is one membership with one link per matching role.
    if (!found.length) return [];
    return [
      {
        id: found[0].id,
        membership_roles: found.map((row) => ({ roles: { name: row.name } })),
      },
    ];
  });
}

export async function listConversationTagsWithKanbanFlag(db: SqlDb, conversationId: string) {
  return listRows(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    const found = await db.run(sql`
      SELECT ct.tag_id, t.is_kanban_column
      FROM chatbase.conversation_tags ct
      JOIN chatbase.tags t ON t.id = ct.tag_id
      ${where([
        sql`ct.conversation_id = ${conversationId}`,
        access ? scope.company(access, "t.company_id") : null,
        access
          ? sql`EXISTS (SELECT 1 FROM chatbase.conversations c
                        WHERE c.id = ct.conversation_id AND ${scope.inbox(access, "c.inbox_id")})`
          : null,
      ])}`);
    return found.map((row) => ({
      tag_id: row.tag_id,
      tags: { is_kanban_column: row.is_kanban_column },
    }));
  });
}

export async function removeConversationTags(db: SqlDb, conversationId: string, tagIds: string[]) {
  return done(async () => {
    if (!isUuid(conversationId) || !tagIds.every(isUuid)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE ct FROM chatbase.conversation_tags ct
      ${where([
        sql`ct.conversation_id = ${conversationId}`,
        sql`ct.tag_id IN ${uuidList(tagIds)}`,
        access
          ? sql`EXISTS (SELECT 1 FROM chatbase.conversations c
                        WHERE c.id = ct.conversation_id
                          AND ${scope.inbox(access, "c.inbox_id")}
                          AND ${scope.companyWith(access, "c.company_id", "conversations.tag")})`
          : null,
      ])}`);
  });
}

export async function addConversationTag(db: SqlDb, conversationId: string, tagId: string) {
  return done(async () => {
    const access = await accessOf(db);
    await inTransaction(db, async (tx) => {
      await requireConversationPermission(tx, access, conversationId, "conversations.tag");
      // Port of the enforce_one_kanban_tag trigger, which ran with the caller's RLS on tags.
      const [tag] = await tx.run(sql`
        SELECT is_kanban_column FROM chatbase.tags
        ${where([
          sql`id = ${tagId}`,
          access ? scope.company(access, "company_id") : null,
        ])}`);
      if (tag?.is_kanban_column) {
        await tx.run(sql`
          DELETE ct FROM chatbase.conversation_tags ct
          JOIN chatbase.tags t ON t.id = ct.tag_id
          ${where([
            sql`ct.conversation_id = ${conversationId}`,
            sql`t.is_kanban_column = 1`,
            sql`ct.tag_id <> ${tagId}`,
            access ? scope.company(access, "t.company_id") : null,
          ])}`);
      }
      await tx.run(sql`
        INSERT INTO chatbase.conversation_tags (conversation_id, tag_id)
        VALUES (${conversationId}, ${tagId})`);
    });
  });
}

export async function findInboxForNewConversation(db: SqlDb, inboxId: string) {
  return one(async () => {
    if (!isUuid(inboxId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, company_id, phone_number FROM chatbase.inboxes
      ${where([
        sql`id = ${inboxId}`,
        access ? scope.inboxesRead(access, "id", "company_id") : null,
      ])}`);
  });
}

export async function upsertContactByPhone(
  db: SqlDb,
  contact: { companyId: string; phoneNumber: string; name: string },
) {
  return one(async () => {
    const access = await accessOf(db);
    // Access ids are lowercase; Postgres compared uuids by value.
    if (access && !hasCompanyAccess(access, contact.companyId.toLowerCase())) throw rlsViolation();
    return inTransaction(db, async (tx) => {
      const [existing] = await tx.run(sql`
        SELECT id FROM chatbase.contacts WITH (UPDLOCK, HOLDLOCK)
        WHERE company_id = ${contact.companyId} AND phone_number = ${contact.phoneNumber}`);
      if (existing) {
        return tx.run(sql`
          UPDATE chatbase.contacts
          SET name = ${contact.name}, updated_at = SYSUTCDATETIME()
          OUTPUT INSERTED.id
          WHERE id = ${existing.id as string}`);
      }
      return tx.run(sql`
        INSERT INTO chatbase.contacts (company_id, phone_number, name)
        OUTPUT INSERTED.id
        VALUES (${contact.companyId}, ${contact.phoneNumber}, ${contact.name})`);
    });
  });
}

export async function upsertOpenConversation(
  db: SqlDb,
  conversation: {
    companyId: string;
    inboxId: string;
    contactId: string;
    assigneeId: string;
  },
) {
  return one(async () => {
    const access = await accessOf(db);
    // The chain returns the row, so Postgres also applied conversations_select to it.
    if (
      access &&
      !(
        hasInboxAccess(access, conversation.inboxId.toLowerCase()) &&
        hasPermission(access, conversation.companyId.toLowerCase(), "conversations.view")
      )
    ) {
      throw rlsViolation();
    }
    return inTransaction(db, async (tx) => {
      const [existing] = await tx.run(sql`
        SELECT id FROM chatbase.conversations WITH (UPDLOCK, HOLDLOCK)
        WHERE inbox_id = ${conversation.inboxId} AND contact_id = ${conversation.contactId}`);
      if (existing) {
        return tx.run(sql`
          UPDATE chatbase.conversations
          SET company_id = ${conversation.companyId},
              status = N'open',
              assignee_id = ${conversation.assigneeId},
              updated_at = SYSUTCDATETIME()
          OUTPUT INSERTED.id
          WHERE id = ${existing.id as string}`);
      }
      return tx.run(sql`
        INSERT INTO chatbase.conversations (company_id, inbox_id, contact_id, status, assignee_id)
        OUTPUT INSERTED.id
        VALUES (${conversation.companyId}, ${conversation.inboxId}, ${conversation.contactId},
                N'open', ${conversation.assigneeId})`);
    });
  });
}

export async function listCompaniesByName(db: SqlDb) {
  return listRows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, name FROM chatbase.companies
      ${where([access ? scope.company(access, "id") : null])}
      ORDER BY name`);
  });
}

async function listTagOptions(db: SqlDb, kanban: boolean, orderBy: "position" | "name") {
  const access = await accessOf(db);
  return db.run(sql`
    SELECT id, name, color, company_id FROM chatbase.tags
    ${where([
      sql`is_kanban_column = ${kanban}`,
      access ? scope.company(access, "company_id") : null,
    ])}
    ORDER BY ${raw(orderBy)}`);
}

export async function listKanbanTagOptions(db: SqlDb) {
  return listRows(() => listTagOptions(db, true, "position"));
}

export async function listContactTagOptions(db: SqlDb) {
  return listRows(() => listTagOptions(db, false, "name"));
}

export async function findCompanyByGuid(db: SqlDb, guid: string) {
  return maybeOne(async () => {
    const access = await accessOf(db);
    // guid_company is free text, not a uuid. Postgres compared it exactly.
    return db.run(sql`
      SELECT id FROM chatbase.companies
      ${where([
        sql`guid_company COLLATE Latin1_General_100_BIN2 = ${guid}`,
        access ? scope.company(access, "id") : null,
      ])}`);
  });
}

export async function findCompanyById(db: SqlDb, companyId: string) {
  return maybeOne(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id FROM chatbase.companies
      ${where([
        sql`id = ${companyId}`,
        access ? scope.company(access, "id") : null,
      ])}`);
  });
}

export async function listContactsByPhoneNumbers(
  db: SqlDb,
  companyId: string,
  phoneNumbers: string[],
) {
  return listRows(async () => {
    if (!isUuid(companyId)) return [];
    const access = await accessOf(db);
    // The explicit collation settles the comparison with OPENJSON's value column.
    return db.run(sql`
      SELECT TOP (5) id FROM chatbase.contacts
      ${where([
        sql`company_id = ${companyId}`,
        sql`phone_number COLLATE Latin1_General_100_BIN2 IN ${textList(phoneNumbers)}`,
        access ? scope.company(access, "company_id") : null,
      ])}`);
  });
}

/** Newest conversation of any of these contacts, as a list of at most one row. */
export async function listLatestConversationOfContacts(
  db: SqlDb,
  companyId: string,
  contactIds: string[],
) {
  return listRows(async () => {
    if (!isUuid(companyId) || !contactIds.every(isUuid)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT TOP (1) id FROM chatbase.conversations
      ${where([
        sql`company_id = ${companyId}`,
        sql`contact_id IN ${uuidList(contactIds)}`,
        access ? scope.conversationsRead(access, "inbox_id") : null,
      ])}
      ORDER BY last_message_at DESC`);
  });
}
