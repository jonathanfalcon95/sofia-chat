import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { InboxesManager } from "@/components/inboxes/inboxes-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

export default async function InboxesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAnyPermission("inboxes.manage");
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const companyId = firstSearchParam(sp.companyId) ?? "";
  const status = firstSearchParam(sp.status) ?? "all";

  const supabase = await createClient();
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .order("name");

  let query = supabase
    .from("inboxes")
    .select(
      "id, name, phone_number, is_active, company_id, ycloud_phone_number_id, waba_id, companies(name)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (companyId === "none") query = query.is("company_id", null);
  else if (companyId) query = query.eq("company_id", companyId);
  if (q) {
    const pattern = ilikePattern(q);
    query = query.or(
      `name.ilike."${pattern}",phone_number.ilike."${pattern}"`,
    );
  }

  const { data: inboxes, count } = await query.range(from, to);

  const normalized =
    inboxes?.map((i) => ({
      ...i,
      companies: Array.isArray(i.companies) ? i.companies[0] : i.companies,
    })) ?? [];

  return (
    <InboxesManager
      inboxes={normalized as never}
      companies={companies ?? []}
      canSync={Boolean(session?.isPlatformAdmin)}
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, companyId, status }}
    />
  );
}
