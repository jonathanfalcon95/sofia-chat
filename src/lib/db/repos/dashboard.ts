import type { Db } from "../types";

/**
 * Totals for the dashboard. `inboxIds` carries the caller's visibility: null means no filter
 * (platform admins) and an empty list matches nothing, so never test it by length.
 */

/** `orFilter` is a visibleInboxesFilter() expression; null lists every inbox. */
export async function listDashboardInboxes(db: Db, orFilter: string | null) {
  const query = db.from("inboxes").select("id, name, company_id, is_active");
  return orFilter ? query.or(orFilter) : query;
}

export async function listInboxNamesByIds(db: Db, inboxIds: string[]) {
  return db.from("inboxes").select("id, name").in("id", inboxIds);
}

export async function countCompanies(db: Db) {
  return db.from("companies").select("*", { count: "exact", head: true });
}

export async function countOpenConversations(
  db: Db,
  inboxIds: string[] | null,
) {
  const query = db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  return inboxIds ? query.in("inbox_id", inboxIds) : query;
}

export async function countUnassignedOpenConversations(
  db: Db,
  inboxIds: string[] | null,
) {
  const query = db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .is("assignee_id", null);
  return inboxIds ? query.in("inbox_id", inboxIds) : query;
}

export async function countConversationsInsideWindow(
  db: Db,
  nowIso: string,
  inboxIds: string[] | null,
) {
  const query = db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .gt("window_expires_at", nowIso);
  return inboxIds ? query.in("inbox_id", inboxIds) : query;
}

export async function countConversationsOutsideWindow(
  db: Db,
  nowIso: string,
  inboxIds: string[] | null,
) {
  const query = db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .or(`window_expires_at.is.null,window_expires_at.lte.${nowIso}`);
  return inboxIds ? query.in("inbox_id", inboxIds) : query;
}

export async function countOpenConversationsInInbox(db: Db, inboxId: string) {
  return db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("inbox_id", inboxId)
    .eq("status", "open");
}

export async function countTicketsByStatus(db: Db, status: string) {
  return db
    .from("tickets")
    .select("*", { count: "exact", head: true })
    .eq("status", status);
}

/** `companyIds` null counts every company's contacts; an empty list matches nothing. */
export async function countContacts(db: Db, companyIds: string[] | null) {
  const query = db
    .from("contacts")
    .select("id", { count: "exact", head: true });
  return companyIds ? query.in("company_id", companyIds) : query;
}

export async function countMessagesSince(
  db: Db,
  direction: string,
  sinceIso: string,
  inboxIds: string[] | null,
) {
  const query = db
    .from("messages")
    .select(inboxIds ? "id, conversations!inner(inbox_id)" : "id", {
      count: "exact",
      head: true,
    })
    .eq("direction", direction)
    .gte("created_at", sinceIso);
  return inboxIds ? query.in("conversations.inbox_id", inboxIds) : query;
}
