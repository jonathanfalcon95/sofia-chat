"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function assignConversation(
  conversationId: string,
  assigneeId: string | null,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No autenticado");

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, company_id")
    .eq("id", conversationId)
    .single();
  if (convError || !conversation) throw new Error("Conversación no encontrada");

  if (assigneeId) {
    const { data: membership } = await supabase
      .from("company_memberships")
      .select("id")
      .eq("user_id", assigneeId)
      .eq("company_id", conversation.company_id)
      .eq("is_active", true)
      .maybeSingle();
    if (!membership) {
      throw new Error(
        "Solo puedes asignar a agentes de la misma empresa de la conversación",
      );
    }
  }

  const { error } = await supabase
    .from("conversations")
    .update({ assignee_id: assigneeId })
    .eq("id", conversationId);
  if (error) throw new Error(error.message);
  revalidatePath("/conversations");
  revalidatePath(`/conversations/${conversationId}`);
}

export async function setConversationTag(conversationId: string, tagId: string) {
  const supabase = await createClient();
  // Remove previous kanban tags then insert
  const { data: current } = await supabase
    .from("conversation_tags")
    .select("tag_id, tags!inner(is_kanban_column)")
    .eq("conversation_id", conversationId);

  const kanbanTagIds =
    current
      ?.filter((row) => {
        const tag = Array.isArray(row.tags) ? row.tags[0] : row.tags;
        return Boolean((tag as { is_kanban_column?: boolean } | null)?.is_kanban_column);
      })
      .map((row) => row.tag_id) ?? [];

  if (kanbanTagIds.length) {
    await supabase
      .from("conversation_tags")
      .delete()
      .eq("conversation_id", conversationId)
      .in("tag_id", kanbanTagIds);
  }

  const { error } = await supabase.from("conversation_tags").insert({
    conversation_id: conversationId,
    tag_id: tagId,
  });
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

  const { error } = await supabase.from("conversation_notes").insert({
    conversation_id: conversationId,
    company_id: companyId,
    author_id: user.id,
    body,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/conversations/${conversationId}`);
}

export async function createTicket(input: {
  companyId: string;
  conversationId: string;
  title: string;
  description: string;
  priority?: string;
  assigneeId?: string | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No autenticado");

  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) throw new Error("El título es obligatorio");
  if (!description) throw new Error("La descripción es obligatoria");

  const priority = input.priority ?? "medium";
  if (!["low", "medium", "high", "urgent"].includes(priority)) {
    throw new Error("Prioridad inválida");
  }

  const { error } = await supabase.from("tickets").insert({
    company_id: input.companyId,
    conversation_id: input.conversationId,
    title,
    description,
    priority,
    assignee_id: input.assigneeId ?? null,
    created_by: user.id,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
  revalidatePath(`/conversations/${input.conversationId}`);
}

export async function updateTicketStatus(ticketId: string, status: string) {
  const supabase = await createClient();
  if (!["open", "in_progress", "resolved", "closed"].includes(status)) {
    throw new Error("Estado inválido");
  }
  const { error } = await supabase
    .from("tickets")
    .update({ status })
    .eq("id", ticketId);
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
}

export async function updateTicketPriority(
  ticketId: string,
  priority: string,
) {
  const supabase = await createClient();
  if (!["low", "medium", "high", "urgent"].includes(priority)) {
    throw new Error("Prioridad inválida");
  }
  const { error } = await supabase
    .from("tickets")
    .update({ priority })
    .eq("id", ticketId);
  if (error) throw new Error(error.message);
  revalidatePath("/tickets");
}

export async function updateTicketAssignee(
  ticketId: string,
  assigneeId: string | null,
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No autenticado");

  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id, company_id")
    .eq("id", ticketId)
    .single();
  if (ticketError || !ticket) throw new Error("Ticket no encontrado");

  if (assigneeId) {
    const { data: membership } = await supabase
      .from("company_memberships")
      .select(
        `
        id,
        membership_roles!inner (
          roles!inner ( name )
        )
      `,
      )
      .eq("user_id", assigneeId)
      .eq("company_id", ticket.company_id)
      .eq("is_active", true)
      .eq("membership_roles.roles.name", "Soporte")
      .maybeSingle();

    if (!membership) {
      throw new Error(
        "Solo puedes asignar el ticket a un agente de Soporte de la misma empresa",
      );
    }
  }

  const { error } = await supabase
    .from("tickets")
    .update({ assignee_id: assigneeId })
    .eq("id", ticketId);
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

  const { data: inbox } = await supabase
    .from("inboxes")
    .select("id, company_id, phone_number")
    .eq("id", input.inboxId)
    .single();
  if (!inbox) throw new Error("inbox_not_found");

  const phone = input.contactPhone.startsWith("+")
    ? input.contactPhone
    : `+${input.contactPhone}`;

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .upsert(
      {
        company_id: inbox.company_id,
        phone_number: phone,
        name: input.contactName || phone,
      },
      { onConflict: "company_id,phone_number" },
    )
    .select("id")
    .single();
  if (contactError || !contact) throw new Error(contactError?.message ?? "contact_failed");

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .upsert(
      {
        company_id: inbox.company_id,
        inbox_id: inbox.id,
        contact_id: contact.id,
        status: "open",
        assignee_id: user.id,
      },
      { onConflict: "inbox_id,contact_id" },
    )
    .select("id")
    .single();
  if (convError || !conversation) throw new Error(convError?.message ?? "conversation_failed");

  return { conversationId: conversation.id as string };
}
