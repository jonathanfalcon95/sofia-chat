import { escapeIlike } from "@/lib/pagination";
import type { TicketPageFilters } from "../../repos/tickets";
import { hasPermission, scope, type Access } from "../access";
import type { Row } from "../connection";
import { accessOf, done, failure, one, type SqlDb } from "../db";
import { containsPattern, isUuid, sql, uuidList, where, type SqlFragment } from "../sql";
import {
  idsOf,
  type ListResult,
  profileEmbed,
  rlsViolation,
  utcTimestamp,
  visibleContacts,
  visibleProfiles,
} from "./conversation-embeds";

function ticketConditions(
  filters: TicketPageFilters,
  access: Access | null,
): SqlFragment {
  // Same characters dropped as the PostgREST filter string, so both backends match the same rows.
  const pattern = filters.search ? containsPattern(escapeIlike(filters.search)) : null;
  return where([
    filters.createdBy ? sql`created_by = ${filters.createdBy}` : null,
    filters.status !== "all" ? sql`status = ${filters.status}` : null,
    filters.priority !== "all" ? sql`priority = ${filters.priority}` : null,
    filters.assigneeId
      ? sql`assignee_id = ${filters.assigneeId}`
      : filters.unassignedOnly
        ? sql`assignee_id IS NULL`
        : null,
    pattern ? sql`(title LIKE ${pattern} OR description LIKE ${pattern})` : null,
    access ? scope.ticketsRead(access, "company_id") : null,
  ]);
}

/** The embeds of the ticket page, one query per table. */
async function withPageEmbeds(db: SqlDb, access: Access | null, tickets: Row[]) {
  if (!tickets.length) return [];
  const profileIds = [
    ...new Set(
      ["assignee_id", "created_by", "support_responded_by"].flatMap((column) =>
        idsOf(tickets, column),
      ),
    ),
  ];
  const [companies, profiles, conversations] = await Promise.all([
    db.run(sql`
      SELECT id, name FROM chatbase.companies
      ${where([
        sql`id IN ${uuidList(idsOf(tickets, "company_id"))}`,
        access ? scope.company(access, "id") : null,
      ])}`),
    visibleProfiles(db, access, profileIds),
    db.run(sql`
      SELECT id, contact_id FROM chatbase.conversations
      ${where([
        sql`id IN ${uuidList(idsOf(tickets, "conversation_id"))}`,
        access ? scope.conversationsRead(access, "inbox_id") : null,
      ])}`),
  ]);
  const contacts = await visibleContacts(db, access, idsOf(conversations, "contact_id"));

  return tickets.map((ticket) => {
    const company = companies.find((row) => row.id === ticket.company_id);
    const conversation = conversations.find((row) => row.id === ticket.conversation_id);
    const contact = conversation && contacts.get(conversation.contact_id as string);
    return {
      ...ticket,
      companies: company ? { name: company.name } : null,
      assignee: profileEmbed(profiles, ticket.assignee_id),
      creator: profileEmbed(profiles, ticket.created_by),
      responder: profileEmbed(profiles, ticket.support_responded_by),
      conversations: conversation
        ? {
            id: conversation.id,
            contacts: contact
              ? { name: contact.name, phone_number: contact.phone_number }
              : null,
          }
        : null,
    };
  });
}

export async function listTicketsPage(
  db: SqlDb,
  filters: TicketPageFilters,
  from: number,
  to: number,
): Promise<ListResult> {
  try {
    const ids = [filters.createdBy, filters.assigneeId].filter(Boolean);
    if (!ids.every(isUuid)) return { data: [], error: null, count: 0 };

    const access = await accessOf(db);
    const conditions = ticketConditions(filters, access);
    const [counted, tickets] = await Promise.all([
      db.run(sql`SELECT COUNT(*) AS total FROM chatbase.tickets ${conditions}`),
      db.run(sql`
        SELECT id, title, description, status, priority, company_id, conversation_id,
               assignee_id, created_by, created_at, updated_at,
               support_response, support_responded_at, support_responded_by
        FROM chatbase.tickets
        ${conditions}
        ORDER BY created_at DESC, id DESC
        OFFSET ${from} ROWS FETCH NEXT ${to - from + 1} ROWS ONLY`),
    ]);
    return {
      data: await withPageEmbeds(db, access, tickets),
      error: null,
      count: counted[0].total as number,
    };
  } catch (err) {
    return failure(err);
  }
}

export async function insertTicket(
  db: SqlDb,
  ticket: {
    companyId: string;
    conversationId: string;
    title: string;
    description: string;
    priority: string;
    createdBy: string;
  },
) {
  return done(async () => {
    const access = await accessOf(db);
    // Access ids are lowercase; Postgres compared uuids by value.
    if (access && !hasPermission(access, ticket.companyId.toLowerCase(), "tickets.manage")) {
      throw rlsViolation();
    }
    await db.run(sql`
      INSERT INTO chatbase.tickets
        (company_id, conversation_id, title, description, priority, assignee_id, created_by)
      VALUES (${ticket.companyId}, ${ticket.conversationId}, ${ticket.title},
              ${ticket.description}, ${ticket.priority}, NULL, ${ticket.createdBy})`);
  });
}

export async function getTicketOwnership(db: SqlDb, ticketId: string) {
  return one(async () => {
    if (!isUuid(ticketId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, company_id, created_by, conversation_id FROM chatbase.tickets
      ${where([
        sql`id = ${ticketId}`,
        access ? scope.ticketsRead(access, "company_id") : null,
      ])}`);
  });
}

async function updateTicket(db: SqlDb, ticketId: string, assignments: SqlFragment) {
  return done(async () => {
    if (!isUuid(ticketId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.tickets
      SET ${assignments}, updated_at = SYSUTCDATETIME()
      ${where([
        sql`id = ${ticketId}`,
        access ? scope.companyWith(access, "company_id", "tickets.manage") : null,
      ])}`);
  });
}

export async function setTicketContent(
  db: SqlDb,
  ticketId: string,
  content: { title: string; description: string; priority: string },
) {
  return updateTicket(
    db,
    ticketId,
    sql`title = ${content.title}, description = ${content.description}, priority = ${content.priority}`,
  );
}

export async function setTicketStatus(db: SqlDb, ticketId: string, status: string) {
  return updateTicket(db, ticketId, sql`status = ${status}`);
}

export async function setTicketAssignee(
  db: SqlDb,
  ticketId: string,
  assigneeId: string | null,
) {
  return updateTicket(db, ticketId, sql`assignee_id = ${assigneeId}`);
}

export async function setTicketSupportResponse(
  db: SqlDb,
  ticketId: string,
  response: { body: string; respondedAt: string; respondedBy: string },
) {
  return updateTicket(
    db,
    ticketId,
    sql`support_response = ${response.body},
        support_responded_at = ${utcTimestamp(response.respondedAt)},
        support_responded_by = ${response.respondedBy}`,
  );
}
