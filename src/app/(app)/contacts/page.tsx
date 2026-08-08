import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionHasAnyPermission,
} from "@/lib/rbac/session";
import { ContactsManager } from "@/components/contacts/contacts-manager";

export default async function ContactsPage() {
  const session = await getAppSession();
  const supabase = await createClient();
  const [{ data: contacts }, { data: contactTags }, { data: companies }] =
    await Promise.all([
      supabase
        .from("contacts")
        .select(
          `
          id, name, phone_number, company_id,
          companies(name),
          contact_tags ( tag_id, tags ( id, name, color, is_kanban_column ) )
        `,
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("tags")
        .select("id, name, color, company_id")
        .eq("is_kanban_column", false)
        .order("name"),
      supabase.from("companies").select("id, name").order("name"),
    ]);

  const normalized =
    contacts?.map((c) => ({
      ...c,
      companies: Array.isArray(c.companies) ? c.companies[0] : c.companies,
      contact_tags: (c.contact_tags ?? [])
        .map((ct) => ({
          tag_id: ct.tag_id,
          tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
        }))
        .filter(
          (ct) =>
            ct.tags &&
            !(ct.tags as { is_kanban_column?: boolean }).is_kanban_column,
        ),
    })) ?? [];

  const canManageTags = Boolean(
    session &&
      (sessionHasAnyPermission(session, "tags.manage") ||
        sessionHasAnyPermission(session, "kanban.manage") ||
        sessionHasAnyPermission(session, "inboxes.manage")),
  );
  const canAssignTags = Boolean(
    session && sessionHasAnyPermission(session, "conversations.tag"),
  );

  return (
    <ContactsManager
      contacts={normalized as never}
      contactTags={contactTags ?? []}
      companies={companies ?? []}
      canManageTags={canManageTags}
      canAssignTags={canAssignTags}
    />
  );
}
