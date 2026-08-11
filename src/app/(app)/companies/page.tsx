import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { CompaniesManager } from "@/components/companies/companies-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAnyPermission("companies.manage");
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const status = firstSearchParam(sp.status) ?? "all";
  const numbers = firstSearchParam(sp.numbers) ?? "all";

  const supabase = await createClient();

  const { data: allInboxes } = await supabase
    .from("inboxes")
    .select("id, name, phone_number, company_id, is_active")
    .order("name");

  const companyIdsWithInboxes = [
    ...new Set(
      (allInboxes ?? [])
        .map((i) => i.company_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  let query = supabase
    .from("companies")
    .select("id, name, slug, is_active, guid_company", { count: "exact" })
    .order("created_at", { ascending: false });

  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);

  if (q) {
    const pattern = ilikePattern(q);
    query = query.or(
      `name.ilike."${pattern}",slug.ilike."${pattern}",guid_company.ilike."${pattern}"`,
    );
  }

  if (numbers === "with") {
    if (companyIdsWithInboxes.length === 0) {
      return (
        <CompaniesManager
          companies={[]}
          inboxes={(allInboxes ?? []) as never}
          canManage={Boolean(session?.isPlatformAdmin)}
          total={0}
          page={page}
          pageSize={pageSize}
          filters={{ q, status, numbers }}
        />
      );
    }
    query = query.in("id", companyIdsWithInboxes);
  } else if (numbers === "without") {
    if (companyIdsWithInboxes.length > 0) {
      query = query.not(
        "id",
        "in",
        `(${companyIdsWithInboxes.join(",")})`,
      );
    }
  }

  const { data: companies, count } = await query.range(from, to);

  const normalized =
    companies?.map((c) => {
      const companyInboxes = (allInboxes ?? []).filter(
        (i) => i.company_id === c.id,
      );
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
      inboxes={(allInboxes ?? []) as never}
      canManage={Boolean(session?.isPlatformAdmin)}
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, status, numbers }}
    />
  );
}
