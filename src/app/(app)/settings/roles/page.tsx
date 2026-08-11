import { createClient } from "@/lib/supabase/server";
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
  await requireAnyPermission("roles.manage");
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const companyId = firstSearchParam(sp.companyId) ?? "";

  const supabase = await createClient();
  const [{ data: companies }, { data: permissions }] = await Promise.all([
    supabase.from("companies").select("id, name").order("name"),
    supabase.from("permissions").select("code, description").order("code"),
  ]);

  let query = supabase
    .from("roles")
    .select(
      "id, name, description, is_system, company_id, companies(name), role_permissions(permissions(code))",
      { count: "exact" },
    )
    .not("company_id", "is", null)
    .order("name");

  if (companyId) query = query.eq("company_id", companyId);
  if (q) query = query.ilike("name", ilikePattern(q));

  const { data: roles, count } = await query.range(from, to);

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
    />
  );
}
