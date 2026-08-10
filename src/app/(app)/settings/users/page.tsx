import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { UsersManager } from "@/components/users/users-manager";

export default async function UsersPage() {
  await requireAnyPermission("users.manage");
  const supabase = await createClient();
  const [{ data: companies }, { data: roles }, { data: inboxes }, { data: memberships }] =
    await Promise.all([
      supabase.from("companies").select("id, name").order("name"),
      supabase.from("roles").select("id, name, company_id").not("company_id", "is", null),
      supabase
        .from("inboxes")
        .select("id, name, company_id, phone_number, is_active")
        .not("company_id", "is", null)
        .eq("is_active", true),
      supabase
        .from("company_memberships")
        .select(
          `
          id, company_id, user_id, is_active,
          profiles ( email, full_name ),
          membership_inboxes ( inbox_id ),
          membership_roles ( role_id, roles ( name ) )
        `,
        )
        .order("created_at", { ascending: false }),
    ]);

  const normalized =
    memberships?.map((m) => ({
      ...m,
      profiles: Array.isArray(m.profiles) ? m.profiles[0] : m.profiles,
      membership_inboxes: m.membership_inboxes ?? [],
      membership_roles: (m.membership_roles ?? []).map((mr) => ({
        role_id: mr.role_id,
        roles: Array.isArray(mr.roles) ? mr.roles[0] : mr.roles,
      })),
    })) ?? [];

  return (
    <UsersManager
      companies={companies ?? []}
      roles={roles ?? []}
      inboxes={inboxes ?? []}
      memberships={normalized as never}
    />
  );
}
