import { getUserDb } from "@/lib/db/client";
import { listCompanyNames } from "@/lib/db/repos/companies";
import { listActiveAssignedInboxes } from "@/lib/db/repos/inboxes";
import {
  listMembershipIdsByRole,
  listMembershipsPage,
} from "@/lib/db/repos/memberships";
import { searchProfileIds } from "@/lib/db/repos/profiles";
import { listCompanyRoles } from "@/lib/db/repos/roles";
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

  const db = await getUserDb();
  const [{ data: companies }, { data: roles }, { data: inboxes }] =
    await Promise.all([
      listCompanyNames(db),
      listCompanyRoles(db),
      listActiveAssignedInboxes(db),
    ]);

  let membershipIdsByRole: string[] | null = null;
  if (roleId) {
    const { data: mr } = await listMembershipIdsByRole(db, roleId);
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
    const { data: profiles } = await searchProfileIds(db, pattern);
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

  const { data: memberships, count } = await listMembershipsPage(db, {
    companyId,
    status,
    userIds: userIdsFilter,
    membershipIds: membershipIdsByRole,
    from,
    to,
  });

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
