import { createClient } from "@/lib/supabase/server";
import type { PermissionCode } from "@/lib/rbac/permissions";

export type AppSession = {
  userId: string;
  email: string;
  fullName: string | null;
  isPlatformAdmin: boolean;
  memberships: Array<{
    id: string;
    companyId: string;
    companyName: string;
    roleNames: string[];
    permissions: string[];
    inboxIds: string[];
  }>;
};

/** True if platform admin or any membership has users.manage (company Admin). */
export function sessionIsCompanyAdmin(session: AppSession) {
  if (session.isPlatformAdmin) return true;
  return session.memberships.some(
    (m) =>
      m.permissions.includes("users.manage") ||
      m.roleNames.some((r) => r.toLowerCase() === "admin"),
  );
}

/** Show assigned companies block for Agente/Soporte (not platform/company admin). */
export function sessionShowsAssignedCompanies(session: AppSession) {
  return !sessionIsCompanyAdmin(session);
}

export async function getAppSession(): Promise<AppSession | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, full_name, is_platform_admin")
    .eq("id", user.id)
    .single();

  if (!profile) return null;

  const { data: memberships } = await supabase
    .from("company_memberships")
    .select(
      `
      id,
      company_id,
      companies ( id, name ),
      membership_roles (
        roles (
          name,
          role_permissions ( permissions ( code ) )
        )
      ),
      membership_inboxes ( inbox_id )
    `,
    )
    .eq("user_id", user.id)
    .eq("is_active", true);

  const mapped =
    memberships?.map((m) => {
      const company = Array.isArray(m.companies) ? m.companies[0] : m.companies;
      const permSet = new Set<string>();
      const roleNames: string[] = [];
      const roles = m.membership_roles ?? [];
      for (const mr of roles) {
        const role = Array.isArray(mr.roles) ? mr.roles[0] : mr.roles;
        if (role?.name) roleNames.push(role.name as string);
        const rps = role?.role_permissions ?? [];
        for (const rp of rps) {
          const perm = Array.isArray(rp.permissions)
            ? rp.permissions[0]
            : rp.permissions;
          if (perm?.code) permSet.add(perm.code);
        }
      }
      return {
        id: m.id as string,
        companyId: m.company_id as string,
        companyName: (company as { name?: string } | null)?.name ?? "Empresa",
        roleNames,
        permissions: Array.from(permSet),
        inboxIds: (m.membership_inboxes ?? []).map(
          (i: { inbox_id: string }) => i.inbox_id,
        ),
      };
    }) ?? [];

  return {
    userId: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    isPlatformAdmin: profile.is_platform_admin,
    memberships: mapped,
  };
}

export function sessionHasPermission(
  session: AppSession,
  companyId: string | null | undefined,
  permission: PermissionCode,
) {
  if (session.isPlatformAdmin) return true;
  if (!companyId) return false;
  const membership = session.memberships.find((m) => m.companyId === companyId);
  return Boolean(membership?.permissions.includes(permission));
}

/** True if platform admin or any active membership has the permission. */
export function sessionHasAnyPermission(
  session: AppSession,
  permission: PermissionCode,
) {
  if (session.isPlatformAdmin) return true;
  return session.memberships.some((m) => m.permissions.includes(permission));
}

export function sessionCompanyIds(session: AppSession) {
  if (session.isPlatformAdmin) return null; // all
  return session.memberships.map((m) => m.companyId);
}
