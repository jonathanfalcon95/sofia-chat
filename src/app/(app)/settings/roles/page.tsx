import { getUserDb } from "@/lib/db/client";
import { listCompanyNames } from "@/lib/db/repos/companies";
import { listCompanyRolesPage, listPermissions } from "@/lib/db/repos/roles";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { RolesManager } from "@/components/roles/roles-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAnyPermission("roles.manage");
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const companyId = firstSearchParam(sp.companyId) ?? "";

  const db = await getUserDb();
  const [{ data: companies }, { data: permissions }] = await Promise.all([
    listCompanyNames(db),
    listPermissions(db),
  ]);

  const { data: roles, count } = await listCompanyRolesPage(db, {
    companyId,
    namePattern: q ? ilikePattern(q) : undefined,
    from,
    to,
  });

  const normalized =
    roles?.map((role) => {
      const company = Array.isArray(role.companies)
        ? role.companies[0]
        : role.companies;
      const codes =
        role.role_permissions
          ?.map((rp) => {
            const perm = Array.isArray(rp.permissions)
              ? rp.permissions[0]
              : rp.permissions;
            return perm?.code as string | undefined;
          })
          .filter(Boolean) ?? [];
      return {
        id: role.id as string,
        name: role.name as string,
        description: role.description as string | null,
        is_system: role.is_system as boolean,
        company_id: role.company_id as string,
        companies: company as { name: string } | null,
        codes: codes as string[],
      };
    }) ?? [];

  return (
    <RolesManager
      roles={normalized}
      companies={companies ?? []}
      permissions={permissions ?? []}
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, companyId }}
      isPlatformAdmin={Boolean(session?.isPlatformAdmin)}
    />
  );
}
