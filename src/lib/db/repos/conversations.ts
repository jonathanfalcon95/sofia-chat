import {
  CONVERSATION_LIST_SELECT,
  type AssigneeFilter,
} from "@/lib/conversations/types";
import {
  olderThanCursorFilter,
  type PageCursor,
} from "@/lib/conversations/page-cursor";
import { ilikePattern } from "@/lib/pagination";
import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/conversations";
import type { Db } from "../types";

export type ConversationPageFilters = {
  assignee?: AssigneeFilter;
  currentUserId?: string;
  /** Specific agent profile; takes precedence over mine/unassigned */
  assigneeId?: string;
  contactIds?: string[] | null;
  companyId?: string;
  /** Cursor: only rows after this position in the list */
  before?: PageCursor | null;
  limit: number;
};

export async function listConversationsPage(
  db: Db,
  filters: ConversationPageFilters,
) {
  if (isSqlDb(db)) return sql.listConversationsPage(db, filters);

  let query = db
    .from("conversations")
    .select(CONVERSATION_LIST_SELECT)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(filters.limit);

  if (filters.assigneeId) {
    query = query.eq("assignee_id", filters.assigneeId);
  } else if (filters.assignee === "mine" && filters.currentUserId) {
    query = query.eq("assignee_id", filters.currentUserId);
  } else if (filters.assignee === "unassigned") {
    query = query.is("assignee_id", null);
  }

  if (filters.contactIds) {
    query = query.in("contact_id", filters.contactIds);
  }

  if (filters.companyId) {
    query = query.eq("company_id", filters.companyId);
  }

  if (filters.before) {
    query = query.or(olderThanCursorFilter("last_message_at", filters.before));
  }

  return query;
}

export async function findConversationForList(db: Db, conversationId: string) {
  if (isSqlDb(db)) return sql.findConversationForList(db, conversationId);

  return db
    .from("conversations")
    .select(CONVERSATION_LIST_SELECT)
    .eq("id", conversationId)
    .maybeSingle();
}

/** `query` is the lowercased search text, `digits` only its numbers. */
export async function searchContactIdsByNameOrPhone(
  db: Db,
  query: string,
  digits: string,
  companyId?: string,
) {
  if (isSqlDb(db)) return sql.searchContactIdsByNameOrPhone(db, query, digits, companyId);

  const pattern = ilikePattern(query || digits);
  const orParts = [`name.ilike."${pattern}"`, `phone_number.ilike."${pattern}"`];
  if (digits && digits !== query) {
    orParts.push(`phone_number.ilike."%${digits.replace(/[%_,."'\\()]/g, "")}%"`);
  }

  let contactsQuery = db.from("contacts").select("id").or(orParts.join(","));
  if (companyId) contactsQuery = contactsQuery.eq("company_id", companyId);

  return contactsQuery.limit(500);
}

export async function listContactIdsByTag(db: Db, contactTagId: string) {
  if (isSqlDb(db)) return sql.listContactIdsByTag(db, contactTagId);

  return db
    .from("contact_tags")
    .select("contact_id")
    .eq("tag_id", contactTagId)
    .limit(2000);
}

/** No write (and no realtime event for every subscriber) when already read. */
export async function markConversationRead(db: Db, conversationId: string) {
  if (isSqlDb(db)) return sql.markConversationRead(db, conversationId);

  return db
    .from("conversations")
    .update({ unread_count: 0 })
    .eq("id", conversationId)
    .gt("unread_count", 0);
}

export async function findConversationAssignee(db: Db, conversationId: string) {
  if (isSqlDb(db)) return sql.findConversationAssignee(db, conversationId);

  return db
    .from("conversations")
    .select("assignee_id")
    .eq("id", conversationId)
    .maybeSingle();
}

export async function listConversationsAssignedTo(db: Db, userId: string) {
  if (isSqlDb(db)) return sql.listConversationsAssignedTo(db, userId);

  return db
    .from("conversations")
    .select("id, assignee_id")
    .eq("assignee_id", userId)
    .limit(500);
}

export async function getConversationCompany(db: Db, conversationId: string) {
  if (isSqlDb(db)) return sql.getConversationCompany(db, conversationId);

  return db
    .from("conversations")
    .select("id, company_id")
    .eq("id", conversationId)
    .single();
}

export async function setConversationAssignee(
  db: Db,
  conversationId: string,
  assigneeId: string | null,
) {
  if (isSqlDb(db)) return sql.setConversationAssignee(db, conversationId, assigneeId);

  return db
    .from("conversations")
    .update({ assignee_id: assigneeId })
    .eq("id", conversationId);
}

/** Active membership of this user in this company holding a role with this exact name. */
export async function findActiveMembershipWithRole(
  db: Db,
  userId: string,
  companyId: string,
  roleName: string,
) {
  if (isSqlDb(db)) return sql.findActiveMembershipWithRole(db, userId, companyId, roleName);

  return db
    .from("company_memberships")
    .select(
      `
        id,
        membership_roles!inner (
          roles!inner ( name )
        )
      `,
    )
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("membership_roles.roles.name", roleName)
    .maybeSingle();
}

export async function listConversationTagsWithKanbanFlag(
  db: Db,
  conversationId: string,
) {
  if (isSqlDb(db)) return sql.listConversationTagsWithKanbanFlag(db, conversationId);

  return db
    .from("conversation_tags")
    .select("tag_id, tags!inner(is_kanban_column)")
    .eq("conversation_id", conversationId);
}

export async function removeConversationTags(
  db: Db,
  conversationId: string,
  tagIds: string[],
) {
  if (isSqlDb(db)) return sql.removeConversationTags(db, conversationId, tagIds);

  return db
    .from("conversation_tags")
    .delete()
    .eq("conversation_id", conversationId)
    .in("tag_id", tagIds);
}

export async function addConversationTag(
  db: Db,
  conversationId: string,
  tagId: string,
) {
  if (isSqlDb(db)) return sql.addConversationTag(db, conversationId, tagId);

  return db.from("conversation_tags").insert({
    conversation_id: conversationId,
    tag_id: tagId,
  });
}

export async function findInboxForNewConversation(db: Db, inboxId: string) {
  if (isSqlDb(db)) return sql.findInboxForNewConversation(db, inboxId);

  return db
    .from("inboxes")
    .select("id, company_id, phone_number")
    .eq("id", inboxId)
    .single();
}

export async function upsertContactByPhone(
  db: Db,
  contact: { companyId: string; phoneNumber: string; name: string },
) {
  if (isSqlDb(db)) return sql.upsertContactByPhone(db, contact);

  return db
    .from("contacts")
    .upsert(
      {
        company_id: contact.companyId,
        phone_number: contact.phoneNumber,
        name: contact.name,
      },
      { onConflict: "company_id,phone_number" },
    )
    .select("id")
    .single();
}

export async function upsertOpenConversation(
  db: Db,
  conversation: {
    companyId: string;
    inboxId: string;
    contactId: string;
    assigneeId: string;
  },
) {
  if (isSqlDb(db)) return sql.upsertOpenConversation(db, conversation);

  return db
    .from("conversations")
    .upsert(
      {
        company_id: conversation.companyId,
        inbox_id: conversation.inboxId,
        contact_id: conversation.contactId,
        status: "open",
        assignee_id: conversation.assigneeId,
      },
      { onConflict: "inbox_id,contact_id" },
    )
    .select("id")
    .single();
}

export async function listCompaniesByName(db: Db) {
  if (isSqlDb(db)) return sql.listCompaniesByName(db);

  return db.from("companies").select("id, name").order("name");
}

export async function listKanbanTagOptions(db: Db) {
  if (isSqlDb(db)) return sql.listKanbanTagOptions(db);

  return db
    .from("tags")
    .select("id, name, color, company_id")
    .eq("is_kanban_column", true)
    .order("position");
}

export async function listContactTagOptions(db: Db) {
  if (isSqlDb(db)) return sql.listContactTagOptions(db);

  return db
    .from("tags")
    .select("id, name, color, company_id")
    .eq("is_kanban_column", false)
    .order("name");
}

export async function findCompanyByGuid(db: Db, guid: string) {
  if (isSqlDb(db)) return sql.findCompanyByGuid(db, guid);

  return db
    .from("companies")
    .select("id")
    .eq("guid_company", guid)
    .maybeSingle();
}

export async function findCompanyById(db: Db, companyId: string) {
  if (isSqlDb(db)) return sql.findCompanyById(db, companyId);

  return db.from("companies").select("id").eq("id", companyId).maybeSingle();
}

export async function listContactsByPhoneNumbers(
  db: Db,
  companyId: string,
  phoneNumbers: string[],
) {
  if (isSqlDb(db)) return sql.listContactsByPhoneNumbers(db, companyId, phoneNumbers);

  return db
    .from("contacts")
    .select("id")
    .eq("company_id", companyId)
    .in("phone_number", phoneNumbers)
    .limit(5);
}

/** Newest conversation of any of these contacts, as a list of at most one row. */
export async function listLatestConversationOfContacts(
  db: Db,
  companyId: string,
  contactIds: string[],
) {
  if (isSqlDb(db)) return sql.listLatestConversationOfContacts(db, companyId, contactIds);

  return db
    .from("conversations")
    .select("id")
    .eq("company_id", companyId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
}
