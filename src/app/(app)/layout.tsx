import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { loginUrlWithNext } from "@/lib/auth/safe-next-path";
import { getAppSession } from "@/lib/rbac/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAppSession();
  if (!session) {
    const headerList = await headers();
    const pathname = headerList.get("x-pathname") ?? "";
    const search = headerList.get("x-search") ?? "";
    redirect(loginUrlWithNext(pathname, search));
  }

  const permissions = Array.from(
    new Set(session.memberships.flatMap((m) => m.permissions)),
  );

  return (
    <AppShell
      userId={session.userId}
      userLabel={session.fullName || session.email}
      permissions={permissions}
      isPlatformAdmin={session.isPlatformAdmin}
    >
      {children}
    </AppShell>
  );
}
