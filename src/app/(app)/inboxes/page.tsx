import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { InboxesManager } from "@/components/inboxes/inboxes-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";
import { listYCloudAccounts } from "@/app/actions/admin";

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
  const ycloudAccountId = firstSearchParam(sp.ycloudAccountId) ?? "";

  const supabase = await createClient();
  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .order("name");

  const accounts = session?.isPlatformAdmin ? await listYCloudAccounts() : [];

  let query = supabase
    .from("inboxes")
    .select(
      "id, name, phone_number, is_active, company_id, ycloud_phone_number_id, waba_id, ycloud_account_id, companies(name)",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (companyId === "none") query = query.is("company_id", null);
  else if (companyId) query = query.eq("company_id", companyId);
  if (ycloudAccountId) query = query.eq("ycloud_account_id", ycloudAccountId);
  if (q) {
    const pattern = ilikePattern(q);
    query = query.or(
      `name.ilike."${pattern}",phone_number.ilike."${pattern}"`,
    );
  }

  const { data: inboxes, count } = await query.range(from, to);
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  const normalized =
    inboxes?.map((i) => ({
      ...i,
      companies: Array.isArray(i.companies) ? i.companies[0] : i.companies,
      ycloud_account_name: i.ycloud_account_id
        ? (accountNameById.get(i.ycloud_account_id as string) ?? null)
        : null,
    })) ?? [];

  return (
    <InboxesManager
      inboxes={normalized as never}
      companies={companies ?? []}
      accounts={accounts}
      canSync={Boolean(session?.isPlatformAdmin)}
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, companyId, status, ycloudAccountId }}
    />
  );
}
