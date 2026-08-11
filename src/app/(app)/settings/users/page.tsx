import { createClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/rbac/require-permission";
import { UsersManager } from "@/components/users/users-manager";
import {
  firstSearchParam,
  ilikePattern,
  parsePageParams,
} from "@/lib/pagination";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAnyPermission("users.manage");
  const sp = await searchParams;
  const { page, pageSize, from, to } = parsePageParams(sp);
  const q = (firstSearchParam(sp.q) ?? "").trim();
  const companyId = firstSearchParam(sp.companyId) ?? "";
  const roleId = firstSearchParam(sp.roleId) ?? "";
  const status = firstSearchParam(sp.status) ?? "all";

  const supabase = await createClient();
  const [{ data: companies }, { data: roles }, { data: inboxes }] =
    await Promise.all([
      supabase.from("companies").select("id, name").order("name"),
      supabase
        .from("roles")
        .select("id, name, company_id")
        .not("company_id", "is", null),
      supabase
        .from("inboxes")
        .select("id, name, company_id, phone_number, is_active")
        .not("company_id", "is", null)
        .eq("is_active", true),
    ]);

  let membershipIdsByRole: string[] | null = null;
  if (roleId) {
    const { data: mr } = await supabase
      .from("membership_roles")
      .select("membership_id")
      .eq("role_id", roleId);
    membershipIdsByRole = (mr ?? []).map((r) => r.membership_id as string);
    if (membershipIdsByRole.length === 0) {
      return (
        <UsersManager
          companies={companies ?? []}
          roles={roles ?? []}
          inboxes={inboxes ?? []}
          memberships={[]}
          total={0}
          page={page}
          pageSize={pageSize}
          filters={{ q, companyId, roleId, status }}
        />
      );
    }
  }

  let userIdsFilter: string[] | null = null;
  if (q) {
    const pattern = ilikePattern(q);
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id")
      .or(`email.ilike."${pattern}",full_name.ilike."${pattern}"`);
    userIdsFilter = (profiles ?? []).map((p) => p.id as string);
    if (userIdsFilter.length === 0) {
      return (
        <UsersManager
          companies={companies ?? []}
          roles={roles ?? []}
          inboxes={inboxes ?? []}
          memberships={[]}
          total={0}
          page={page}
          pageSize={pageSize}
          filters={{ q, companyId, roleId, status }}
        />
      );
    }
  }

  let query = supabase
    .from("company_memberships")
    .select(
      `
      id, company_id, user_id, is_active,
      profiles ( email, full_name ),
      membership_inboxes ( inbox_id ),
      membership_roles ( role_id, roles ( name ) )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (companyId) query = query.eq("company_id", companyId);
  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (userIdsFilter) query = query.in("user_id", userIdsFilter);
  if (membershipIdsByRole) query = query.in("id", membershipIdsByRole);

  const { data: memberships, count } = await query.range(from, to);

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
      total={count ?? 0}
      page={page}
      pageSize={pageSize}
      filters={{ q, companyId, roleId, status }}
    />
  );
}
