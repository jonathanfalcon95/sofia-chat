import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { CompaniesManager } from "@/components/companies/companies-manager";

export default async function CompaniesPage() {
  const session = await requireAnyPermission("companies.manage");
  const supabase = await createClient();
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name, slug, is_active")
    .order("created_at", { ascending: false });

  return (
    <CompaniesManager
      companies={companies ?? []}
      canManage={Boolean(session?.isPlatformAdmin)}
    />
  );
}
