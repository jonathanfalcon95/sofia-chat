import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionCompanyIds,
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

  // Sorting and counting a company's contacts under RLS takes seconds. Pick the
  // page by id within the user's companies; the details below still go through
  // RLS, so nothing beyond the total is read on the user's behalf.
  const scopedCompanyIds = session ? sessionCompanyIds(session) : [];
  let idsQuery = createAdminClient()
    .from("contacts")
    .select("id", { count: "exact" })
    .order("created_at", { ascending: false });
  if (scopedCompanyIds) idsQuery = idsQuery.in("company_id", scopedCompanyIds);
  if (companyId) idsQuery = idsQuery.eq("company_id", companyId);
  if (contactIdsByTag) idsQuery = idsQuery.in("id", contactIdsByTag);
  if (q) {
    const pattern = ilikePattern(q);
    idsQuery = idsQuery.or(
      `name.ilike."${pattern}",phone_number.ilike."${pattern}"`,
    );
  }

  const { data: idRows, count, error: idsError } = await idsQuery.range(from, to);
  if (idsError) throw new Error(`Contacts page: ${idsError.message}`);

  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select(
      `
      id, name, phone_number, company_id,
      companies(name),
      contact_tags ( tag_id, tags ( id, name, color, is_kanban_column ) )
    `,
    )
    .in(
      "id",
      (idRows ?? []).map((row) => row.id as string),
    )
    .order("created_at", { ascending: false });
  if (contactsError) throw new Error(`Contacts page: ${contactsError.message}`);

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
