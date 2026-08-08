import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { InboxesManager } from "@/components/inboxes/inboxes-manager";

export default async function InboxesPage() {
  await requireAnyPermission("inboxes.manage");
  const supabase = await createClient();
  const [{ data: inboxes }, { data: companies }] = await Promise.all([
    supabase
      .from("inboxes")
      .select(
        "id, name, phone_number, is_active, company_id, ycloud_phone_number_id, waba_id, companies(name)",
      )
      .order("created_at", { ascending: false }),
    supabase.from("companies").select("id, name").order("name"),
  ]);

  const normalized =
    inboxes?.map((i) => ({
      ...i,
      companies: Array.isArray(i.companies) ? i.companies[0] : i.companies,
    })) ?? [];

  return (
    <InboxesManager inboxes={normalized as never} companies={companies ?? []} />
  );
}
