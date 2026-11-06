"use server";

import { revalidatePath } from "next/cache";
import { getUserDb } from "@/lib/db/client";
import {
  deleteContactTagById,
  deleteContactTagLinks,
  getContactCompanyId,
  insertContactTagLinks,
  insertTag,
  listCompanyContactTagIds,
  updateContactTagById,
} from "@/lib/db/repos/tags";
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

  const db = await getUserDb();
  const { error } = await insertTag(db, {
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

  const db = await getUserDb();
  const { error } = await updateContactTagById(db, input.id, {
    name: input.name.trim(),
    color: input.color,
  });
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

  const db = await getUserDb();
  const { error } = await deleteContactTagById(db, id);
  if (error) throw new Error(error.message);
  revalidatePath("/contacts");
  revalidatePath("/conversations");
}

export async function setContactTags(contactId: string, tagIds: string[]) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const db = await getUserDb();
  const { data: contact } = await getContactCompanyId(db, contactId);
  if (!contact) throw new Error("Contacto no encontrado");

  if (!sessionHasPermission(session, contact.company_id, "conversations.tag")) {
    throw new Error("Sin permiso para etiquetar contactos");
  }

  const unique = Array.from(new Set(tagIds.filter(Boolean)));

  if (unique.length) {
    const { data: valid } = await listCompanyContactTagIds(
      db,
      contact.company_id,
      unique,
    );
    if ((valid?.length ?? 0) !== unique.length) {
      throw new Error("Tag inválido para esta empresa");
    }
  }

  const { error: delError } = await deleteContactTagLinks(db, contactId);
  if (delError) throw new Error(delError.message);

  if (unique.length) {
    const { error } = await insertContactTagLinks(
      db,
      unique.map((tag_id) => ({ contact_id: contactId, tag_id })),
    );
    if (error) throw new Error(error.message);
  }

  revalidatePath("/contacts");
  revalidatePath("/conversations");
  revalidatePath("/kanban");
}
