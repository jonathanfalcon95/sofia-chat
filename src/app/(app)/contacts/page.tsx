import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionHasAnyPermission,
} from "@/lib/rbac/session";
import { ContactsManager } from "@/components/contacts/contacts-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getAppSession();
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const companyId = firstSearchParam(sp.companyId) ?? "";
  const tagId = firstSearchParam(sp.tagId) ?? "";

  const supabase = await createClient();
  const [{ data: contactTags }, { data: companies }] = await Promise.all([
    supabase
      .from("tags")
      .select("id, name, color, company_id")
      .eq("is_kanban_column", false)
      .order("name"),
    supabase.from("companies").select("id, name").order("name"),
  ]);

  let contactIdsByTag: string[] | null = null;
  if (tagId) {
    const { data: tagged } = await supabase
      .from("contact_tags")
      .select("contact_id")
      .eq("tag_id", tagId);
    contactIdsByTag = (tagged ?? []).map((t) => t.contact_id as string);
    if (contactIdsByTag.length === 0) {
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
          contacts={[]}
          contactTags={contactTags ?? []}
          companies={companies ?? []}
          canManageTags={canManageTags}
          canAssignTags={canAssignTags}
          total={0}
          page={page}
          pageSize={pageSize}
          filters={{ q, companyId, tagId }}
        />
      );
    }
  }

  let query = supabase
    .from("contacts")
    .select(
      `
      id, name, phone_number, company_id,
      companies(name),
      contact_tags ( tag_id, tags ( id, name, color, is_kanban_column ) )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (companyId) query = query.eq("company_id", companyId);
  if (contactIdsByTag) query = query.in("id", contactIdsByTag);
  if (q) {
    const pattern = ilikePattern(q);
    query = query.or(`name.ilike."${pattern}",phone_number.ilike."${pattern}"`);
  }

  const { data: contacts, count } = await query.range(from, to);

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
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, companyId, tagId }}
    />
  );
}
