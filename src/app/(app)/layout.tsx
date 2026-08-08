import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getAppSession } from "@/lib/rbac/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAppSession();
  if (!session) redirect("/login");

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
