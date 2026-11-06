import { getUserDb } from "@/lib/db/client";
import { listCompanyNames } from "@/lib/db/repos/companies";
import { listInboxesPage } from "@/lib/db/repos/inboxes";
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

  const db = await getUserDb();
  const { data: companies } = await listCompanyNames(db);

  const accounts = session?.isPlatformAdmin ? await listYCloudAccounts() : [];

  const { data: inboxes, count } = await listInboxesPage(db, {
    status,
    companyId,
    ycloudAccountId,
    searchPattern: q ? ilikePattern(q) : undefined,
    from,
    to,
  });
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
