import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { RolesManager } from "@/components/roles/roles-manager";

export default async function RolesPage() {
  await requireAnyPermission("roles.manage");
  const supabase = await createClient();
  const [{ data: roles }, { data: companies }, { data: permissions }] =
    await Promise.all([
      supabase
        .from("roles")
        .select(
          "id, name, description, is_system, company_id, companies(name), role_permissions(permissions(code))",
        )
        .not("company_id", "is", null)
        .order("name"),
      supabase.from("companies").select("id, name"),
      supabase.from("permissions").select("code, description").order("code"),
    ]);

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
    />
  );
}
