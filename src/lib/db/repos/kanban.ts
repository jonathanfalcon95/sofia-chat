import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/kanban";
import type { Db } from "../types";

const CARD_SELECT = `
  id, last_message_preview, last_message_at, inbox_id, company_id, contact_id, assignee_id,
  contacts ( id, name, phone_number ),
  inboxes ( name )
`;

type FilterableQuery<Q> = {
  eq(column: string, value: string): Q;
  is(column: string, value: null): Q;
  or(filters: string): Q;
  ilike(column: string, pattern: string): Q;
};

export type KanbanConversationFilters = {
  inboxId?: string;
  assignee?: "all" | "mine" | "unassigned";
  userId?: string;
  /** ilike pattern for the search text, or null when not searching. */
  searchPattern: string | null;
  searchContactIds: string[] | null;
};

function withFilters<Q>(query: Q, filters: KanbanConversationFilters): Q {
  let q = query;
  const on = () => q as unknown as FilterableQuery<Q>;
  if (filters.inboxId) q = on().eq("inbox_id", filters.inboxId);
  if (filters.assignee === "mine" && filters.userId) {
    q = on().eq("assignee_id", filters.userId);
  } else if (filters.assignee === "unassigned") {
    q = on().is("assignee_id", null);
  }
  if (filters.searchPattern) {
    q =
      filters.searchContactIds && filters.searchContactIds.length > 0
        ? on().or(
            `contact_id.in.(${filters.searchContactIds.join(",")}),last_message_preview.ilike."${filters.searchPattern}"`,
          )
        : on().ilike("last_message_preview", filters.searchPattern);
  }
  return q;
}

export async function searchKanbanContactIds(
  db: Db,
  companyId: string,
  pattern: string,
) {
  if (isSqlDb(db)) return sql.searchKanbanContactIds(db, companyId, pattern);

  return db
    .from("contacts")
    .select("id")
    .eq("company_id", companyId)
    .or(`name.ilike."${pattern}",phone_number.ilike."${pattern}"`);
}

export async function listTaggedConversationIds(
  db: Db,
  companyId: string,
  tagId: string,
  filters: KanbanConversationFilters,
  from: number,
  to: number,
) {
  if (isSqlDb(db)) return sql.listTaggedConversationIds(db, companyId, tagId, filters, from, to);

  return withFilters(
    db
      .from("conversations")
      .select("id, conversation_tags!inner(tag_id)")
      .eq("company_id", companyId)
      .eq("conversation_tags.tag_id", tagId),
    filters,
  )
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(from, to);
}

export async function listKanbanColumnIds(db: Db, companyId: string) {
  if (isSqlDb(db)) return sql.listKanbanColumnIds(db, companyId);

  return db
    .from("tags")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_kanban_column", true);
}

/** Anti-join: conversations with no link to any of these columns. */
export async function listUntaggedConversationIds(
  db: Db,
  companyId: string,
  columnTagIds: string[],
  filters: KanbanConversationFilters,
  from: number,
  to: number,
) {
  if (isSqlDb(db)) return sql.listUntaggedConversationIds(db, companyId, columnTagIds, filters, from, to);

  return withFilters(
    db
      .from("conversations")
      .select("id, conversation_tags(tag_id)")
      .eq("company_id", companyId)
      .in("conversation_tags.tag_id", columnTagIds)
      .is("conversation_tags", null),
    filters,
  )
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .range(from, to);
}

export async function listKanbanCardRows(db: Db, conversationIds: string[]) {
  if (isSqlDb(db)) return sql.listKanbanCardRows(db, conversationIds);

  return db
    .from("conversations")
    .select(CARD_SELECT)
    .in("id", conversationIds)
    .order("last_message_at", { ascending: false, nullsFirst: false });
}

export async function listKanbanInboxes(db: Db, companyId?: string) {
  if (isSqlDb(db)) return sql.listKanbanInboxes(db, companyId);

  let inboxQuery = db.from("inboxes").select("id, name, company_id");
  if (companyId) inboxQuery = inboxQuery.eq("company_id", companyId);
  return inboxQuery;
}

export async function listKanbanColumns(db: Db, companyId?: string) {
  if (isSqlDb(db)) return sql.listKanbanColumns(db, companyId);

  let tagsQuery = db
    .from("tags")
    .select("id, name, color, position, company_id")
    .eq("is_kanban_column", true)
    .order("position");
  if (companyId) tagsQuery = tagsQuery.eq("company_id", companyId);
  return tagsQuery;
}
