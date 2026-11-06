import { ilikePattern } from "@/lib/pagination";
import type { Db } from "../types";

export type TicketPageFilters = {
  /** Only tickets this user created. */
  createdBy?: string;
  /** "all" means no status filter. */
  status: string;
  /** "all" means no priority filter. */
  priority: string;
  assigneeId?: string;
  unassignedOnly?: boolean;
  /** Free text over title / description. */
  search?: string;
};

export async function listTicketsPage(
  db: Db,
  filters: TicketPageFilters,
  from: number,
  to: number,
) {
  let ticketsQuery = db
    .from("tickets")
    .select(
      `
      id, title, description, status, priority, company_id, conversation_id,
      assignee_id, created_by, created_at, updated_at,
      support_response, support_responded_at, support_responded_by,
      companies ( name ),
      assignee:profiles!tickets_assignee_id_fkey ( full_name, email ),
      creator:profiles!tickets_created_by_fkey ( full_name, email ),
      responder:profiles!tickets_support_responded_by_fkey ( full_name, email ),
      conversations (
        id,
        contacts ( name, phone_number )
      )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.createdBy) {
    ticketsQuery = ticketsQuery.eq("created_by", filters.createdBy);
  }
  if (filters.status !== "all") {
    ticketsQuery = ticketsQuery.eq("status", filters.status);
  }
  if (filters.priority !== "all") {
    ticketsQuery = ticketsQuery.eq("priority", filters.priority);
  }
  if (filters.assigneeId) {
    ticketsQuery = ticketsQuery.eq("assignee_id", filters.assigneeId);
  } else if (filters.unassignedOnly) {
    ticketsQuery = ticketsQuery.is("assignee_id", null);
  }
  if (filters.search) {
    const pattern = ilikePattern(filters.search);
    ticketsQuery = ticketsQuery.or(
      `title.ilike."${pattern}",description.ilike."${pattern}"`,
    );
  }

  return ticketsQuery.range(from, to);
}

export async function insertTicket(
  db: Db,
  ticket: {
    companyId: string;
    conversationId: string;
    title: string;
    description: string;
    priority: string;
    createdBy: string;
  },
) {
  // Agents escalate to the support queue — never assign from create.
  return db.from("tickets").insert({
    company_id: ticket.companyId,
    conversation_id: ticket.conversationId,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    assignee_id: null,
    created_by: ticket.createdBy,
  });
}

export async function getTicketOwnership(db: Db, ticketId: string) {
  return db
    .from("tickets")
    .select("id, company_id, created_by, conversation_id")
    .eq("id", ticketId)
    .single();
}

export async function setTicketContent(
  db: Db,
  ticketId: string,
  content: { title: string; description: string; priority: string },
) {
  return db
    .from("tickets")
    .update({
      title: content.title,
      description: content.description,
      priority: content.priority,
    })
    .eq("id", ticketId);
}

export async function setTicketStatus(db: Db, ticketId: string, status: string) {
  return db.from("tickets").update({ status }).eq("id", ticketId);
}

export async function setTicketAssignee(
  db: Db,
  ticketId: string,
  assigneeId: string | null,
) {
  return db
    .from("tickets")
    .update({ assignee_id: assigneeId })
    .eq("id", ticketId);
}

export async function setTicketSupportResponse(
  db: Db,
  ticketId: string,
  response: { body: string; respondedAt: string; respondedBy: string },
) {
  return db
    .from("tickets")
    .update({
      support_response: response.body,
      support_responded_at: response.respondedAt,
      support_responded_by: response.respondedBy,
    })
    .eq("id", ticketId);
}
