"use server";

import { revalidatePath } from "next/cache";
import { getUserDb } from "@/lib/db/client";
import {
  addConversationTag,
  findActiveMembershipWithRole,
  findInboxForNewConversation,
  getConversationCompany,
  listConversationTagsWithKanbanFlag,
  removeConversationTags,
  setConversationAssignee,
  upsertContactByPhone,
  upsertOpenConversation,
} from "@/lib/db/repos/conversations";
import {
  insertConversationNote,
  removeConversationNote,
} from "@/lib/db/repos/notes";
import {
  getTicketOwnership,
  insertTicket,
  setTicketAssignee,
  setTicketContent,
  setTicketStatus,
  setTicketSupportResponse,
} from "@/lib/db/repos/tickets";
import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionCanEditTicketContentForCompany,
  sessionIsTicketSupportForCompany,
} from "@/lib/rbac/session";

export async function assignConversation(
  conversationId: string,
  assigneeId: string | null,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No autenticado");

  const { data: conversation, error: convError } = await getConversationCompany(
    supabase,
    conversationId,
  );
  if (convError || !conversation) throw new Error("Conversación no encontrada");

  if (assigneeId) {
    const { data: membership } = await findActiveMembershipWithRole(
      supabase,
      assigneeId,
      conversation.company_id,
      "Agente",
    );
    if (!membership) {
      throw new Error(
        "Solo puedes asignar la conversación a un agente de la misma empresa",
      );
    }
  }

  const { error } = await setConversationAssignee(
    supabase,
    conversationId,
    assigneeId,
  );
  if (error) throw new Error(error.message);
  revalidatePath("/conversations");
  revalidatePath(`/conversations/${conversationId}`);
}

export async function setConversationTag(conversationId: string, tagId: string) {
  const db = await getUserDb();
  // Remove previous kanban tags then insert
  const { data: current } = await listConversationTagsWithKanbanFlag(
    db,
    conversationId,
  );

  const kanbanTagIds =
    current
      ?.filter((row) => {
        const tag = Array.isArray(row.tags) ? row.tags[0] : row.tags;
        return Boolean((tag as { is_kanban_column?: boolean } | null)?.is_kanban_column);
      })
      .map((row) => row.tag_id) ?? [];

  if (kanbanTagIds.length) {
    await removeConversationTags(db, conversationId, kanbanTagIds);
  }

  const { error } = await addConversationTag(db, conversationId, tagId);
  if (error) throw new Error(error.message);
  revalidatePath("/kanban");
  revalidatePath("/conversations");
  revalidatePath(`/conversations/${conversationId}`);
}

export async function addConversationNote(conversationId: string, companyId: string, body: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const trimmed = body.trim();
  if (!trimmed) throw new Error("La nota no puede estar vacía");

  const { data, error } = await insertConversationNote(supabase, {
    conversationId,
    companyId,
    authorId: user.id,
    body: trimmed,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/conversations/${conversationId}`);
  return data;
}

export async function deleteConversationNote(noteId: string, conversationId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const { error } = await removeConversationNote(
    supabase,
    noteId,
    conversationId,
  );
  if (error) throw new Error(error.message);
  revalidatePath(`/conversations/${conversationId}`);
}

export async function createTicket(input: {
  companyId: string;
  conversationId: string;
  title: string;
  description: string;
  priority?: string;
}) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");
  if (!sessionCanEditTicketContentForCompany(session, input.companyId)) {
    throw new Error("No tienes permiso para crear tickets");
  }

  const db = await getUserDb();
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new Error("El título es obligatorio");
  if (!description) throw new Error("La descripción es obligatoria");

  const priority = input.priority ?? "medium";
  if (!["low", "medium", "high", "urgent"].includes(priority)) {
    throw new Error("Prioridad inválida");
  }

  const { error } = await insertTicket(db, {
    companyId: input.companyId,
    conversationId: input.conversationId,
    title,
    description,
    priority,
    createdBy: session.userId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
  revalidatePath(`/conversations/${input.conversationId}`);
}

async function getTicketOrThrow(ticketId: string) {
  const db = await getUserDb();
  const { data: ticket, error } = await getTicketOwnership(db, ticketId);
  if (error || !ticket) throw new Error("Ticket no encontrado");
  return ticket;
}

/** Agente (o quien tenga tickets.manage): edita título, descripción y prioridad. */
export async function updateTicketContent(
  ticketId: string,
  input: { title: string; description: string; priority: string },
) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const ticket = await getTicketOrThrow(ticketId);
  if (!sessionCanEditTicketContentForCompany(session, ticket.company_id)) {
    throw new Error("No tienes permiso para editar este ticket");
  }

  const isSupport = sessionIsTicketSupportForCompany(
    session,
    ticket.company_id,
  );
  if (!isSupport && ticket.created_by !== session.userId) {
    throw new Error("Solo puedes editar tickets que creaste");
  }

  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new Error("El título es obligatorio");
  if (!description) throw new Error("La descripción es obligatoria");
  if (!["low", "medium", "high", "urgent"].includes(input.priority)) {
    throw new Error("Prioridad inválida");
  }

  const db = await getUserDb();
  const { error } = await setTicketContent(db, ticketId, {
    title,
    description,
    priority: input.priority,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
}

export async function updateTicketStatus(ticketId: string, status: string) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");
  if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
    throw new Error("Estado inválido");
  }

  const ticket = await getTicketOrThrow(ticketId);
  if (!sessionIsTicketSupportForCompany(session, ticket.company_id)) {
    throw new Error("Solo soporte puede cambiar el estado del ticket");
  }

  const db = await getUserDb();
  const { error } = await setTicketStatus(db, ticketId, status);
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
}

export async function updateTicketAssignee(
  ticketId: string,
  assigneeId: string | null,
) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const ticket = await getTicketOrThrow(ticketId);
  if (!sessionIsTicketSupportForCompany(session, ticket.company_id)) {
    throw new Error("Solo soporte puede asignar tickets");
  }

  const db = await getUserDb();
  if (assigneeId) {
    const { data: membership } = await findActiveMembershipWithRole(
      db,
      assigneeId,
      ticket.company_id,
      "Soporte",
    );

    if (!membership) {
      throw new Error(
        "Solo puedes asignar el ticket a un agente de Soporte de la misma empresa",
      );
    }
  }

  const { error } = await setTicketAssignee(db, ticketId, assigneeId);
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
}

/** Soporte: respuesta / resolución del ticket. */
export async function updateTicketSupportResponse(
  ticketId: string,
  response: string,
) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const ticket = await getTicketOrThrow(ticketId);
  if (!sessionIsTicketSupportForCompany(session, ticket.company_id)) {
    throw new Error("Solo soporte puede responder tickets");
  }

  const body = response.trim();
  if (!body) throw new Error("La respuesta no puede estar vacía");

  const db = await getUserDb();
  const { error } = await setTicketSupportResponse(db, ticketId, {
    body,
    respondedAt: new Date().toISOString(),
    respondedBy: session.userId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
}

export async function startConversationWithTemplate(input: {
  inboxId: string;
  contactPhone: string;
  contactName?: string;
  templateName: string;
  languageCode?: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const { data: inbox } = await findInboxForNewConversation(
    supabase,
    input.inboxId,
  );
  if (!inbox) throw new Error("inbox_not_found");

  const phone = input.contactPhone.startsWith("+")
    ? input.contactPhone
    : `+${input.contactPhone}`;

  const { data: contact, error: contactError } = await upsertContactByPhone(
    supabase,
    {
      companyId: inbox.company_id,
      phoneNumber: phone,
      name: input.contactName || phone,
    },
  );
  if (contactError || !contact) throw new Error(contactError?.message ?? "contact_failed");

  const { data: conversation, error: convError } = await upsertOpenConversation(
    supabase,
    {
      companyId: inbox.company_id,
      inboxId: inbox.id,
      contactId: contact.id,
      assigneeId: user.id,
    },
  );
  if (convError || !conversation) throw new Error(convError?.message ?? "conversation_failed");

  return { conversationId: conversation.id as string };
}
