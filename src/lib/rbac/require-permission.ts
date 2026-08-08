import { redirect } from "next/navigation";
import {
  getAppSession,
  sessionHasAnyPermission,
  type AppSession,
} from "@/lib/rbac/session";
import type { PermissionCode } from "@/lib/rbac/permissions";

export async function requireAnyPermission(
  permission: PermissionCode,
  redirectTo = "/conversations",
): Promise<AppSession> {
  const session = await getAppSession();
  if (!session) redirect("/login");
  if (!sessionHasAnyPermission(session, permission)) {
    redirect(redirectTo);
  }
  return session;
}
