import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { CompaniesManager } from "@/components/companies/companies-manager";

export default async function CompaniesPage() {
  const session = await requireAnyPermission("companies.manage");
  const supabase = await createClient();
  const [{ data: companies }, { data: inboxes }] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, slug, is_active, guid_company")
      .order("created_at", { ascending: false }),
    supabase
      .from("inboxes")
      .select("id, name, phone_number, company_id, is_active")
      .order("name"),
  ]);

  const normalized =
    companies?.map((c) => {
      const companyInboxes = (inboxes ?? []).filter((i) => i.company_id === c.id);
      return {
        ...c,
        guid_company: c.guid_company ?? null,
        inbox_ids: companyInboxes.map((i) => i.id as string),
        inbox_count: companyInboxes.length,
      };
    }) ?? [];

  return (
    <CompaniesManager
      companies={normalized}
      inboxes={(inboxes ?? []) as never}
      canManage={Boolean(session?.isPlatformAdmin)}
    />
  );
}
