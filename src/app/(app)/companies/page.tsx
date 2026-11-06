import { getUserDb } from "@/lib/db/client";
import { listCompaniesPage } from "@/lib/db/repos/companies";
import { listAllInboxes } from "@/lib/db/repos/inboxes";
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

  const db = await getUserDb();

  const { data: allInboxes } = await listAllInboxes(db);

  const companyIdsWithInboxes = [
    ...new Set(
      (allInboxes ?? [])
        .map((i) => i.company_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (numbers === "with" && companyIdsWithInboxes.length === 0) {
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

  const { data: companies, count } = await listCompaniesPage(db, {
    status,
    searchPattern: q ? ilikePattern(q) : undefined,
    includeIds: numbers === "with" ? companyIdsWithInboxes : undefined,
    excludeIds:
      numbers === "without" && companyIdsWithInboxes.length > 0
        ? companyIdsWithInboxes
        : undefined,
    from,
    to,
  });

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
