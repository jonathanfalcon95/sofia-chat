import { getSystemDb, getUserDb } from "@/lib/db/client";
import {
  listCompaniesForContactFilter,
  listContactIdsByTag,
  listContactIdsPage,
  listContactsByIds,
  listContactTagOptions,
} from "@/lib/db/repos/contacts";
import {
  getAppSession,
  sessionCompanyIds,
  sessionHasAnyPermission,
} from "@/lib/rbac/session";
import { ContactsManager } from "@/components/contacts/contacts-manager";
import { firstSearchParam, parsePageParams } from "@/lib/pagination";

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

  const supabase = await getUserDb();
  const [{ data: contactTags }, { data: companies }] = await Promise.all([
    listContactTagOptions(supabase),
    listCompaniesForContactFilter(supabase),
  ]);

  let contactIdsByTag: string[] | null = null;
  if (tagId) {
    const { data: tagged } = await listContactIdsByTag(supabase, tagId);
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
  const {
    data: idRows,
    count,
    error: idsError,
  } = await listContactIdsPage(getSystemDb(), {
    scopedCompanyIds,
    companyId,
    contactIds: contactIdsByTag,
    q,
    from,
    to,
  });
  if (idsError) throw new Error(`Contacts page: ${idsError.message}`);

  const { data: contacts, error: contactsError } = await listContactsByIds(
    supabase,
    (idRows ?? []).map((row) => row.id as string),
  );
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
