"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionHasPermission,
  type AppSession,
} from "@/lib/rbac/session";

function canManageContactTagCatalog(
  session: AppSession,
  companyId: string,
) {
  return (
    sessionHasPermission(session, companyId, "tags.manage") ||
    sessionHasPermission(session, companyId, "kanban.manage") ||
    sessionHasPermission(session, companyId, "inboxes.manage")
  );
}

export async function createContactTag(input: {
  companyId: string;
  name: string;
  color: string;
}) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");
  if (!canManageContactTagCatalog(session, input.companyId)) {
    throw new Error("Sin permiso para crear tags");
  }

  const name = input.name.trim();
  if (!name) throw new Error("Nombre obligatorio");

  const supabase = await createClient();
  const { error } = await supabase.from("tags").insert({
    company_id: input.companyId,
    name,
    color: input.color || "#64748b",
    position: 100,
    is_kanban_column: false,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/contacts");
  revalidatePath("/conversations");
}

export async function updateContactTag(input: {
  id: string;
  companyId: string;
  name: string;
  color: string;
}) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");
  if (!canManageContactTagCatalog(session, input.companyId)) {
    throw new Error("Sin permiso para editar tags");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tags")
    .update({
      name: input.name.trim(),
      color: input.color,
    })
    .eq("id", input.id)
    .eq("is_kanban_column", false);
  if (error) throw new Error(error.message);
  revalidatePath("/contacts");
  revalidatePath("/conversations");
}

export async function deleteContactTag(id: string, companyId: string) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");
  if (!canManageContactTagCatalog(session, companyId)) {
    throw new Error("Sin permiso para eliminar tags");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("tags")
    .delete()
    .eq("id", id)
    .eq("is_kanban_column", false);
  if (error) throw new Error(error.message);
  revalidatePath("/contacts");
  revalidatePath("/conversations");
}

export async function setContactTags(contactId: string, tagIds: string[]) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, company_id")
    .eq("id", contactId)
    .single();
  if (!contact) throw new Error("Contacto no encontrado");

  if (!sessionHasPermission(session, contact.company_id, "conversations.tag")) {
    throw new Error("Sin permiso para etiquetar contactos");
  }

  const unique = Array.from(new Set(tagIds.filter(Boolean)));

  if (unique.length) {
    const { data: valid } = await supabase
      .from("tags")
      .select("id")
      .eq("company_id", contact.company_id)
      .eq("is_kanban_column", false)
      .in("id", unique);
    if ((valid?.length ?? 0) !== unique.length) {
      throw new Error("Tag inválido para esta empresa");
    }
  }

  const { error: delError } = await supabase
    .from("contact_tags")
    .delete()
    .eq("contact_id", contactId);
  if (delError) throw new Error(delError.message);

  if (unique.length) {
    const { error } = await supabase.from("contact_tags").insert(
      unique.map((tag_id) => ({ contact_id: contactId, tag_id })),
    );
    if (error) throw new Error(error.message);
  }

  revalidatePath("/contacts");
  revalidatePath("/conversations");
  revalidatePath("/kanban");
}
