import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionShowsAssignedCompanies,
} from "@/lib/rbac/session";
import { PageHeader } from "@/components/page-header";
import { ProfileForm } from "@/components/profile/profile-form";

export default async function ProfilePage() {
  const session = await getAppSession();
  if (!session) redirect("/login");

  const showAssignedCompanies = sessionShowsAssignedCompanies(session);
  const supabase = await createClient();
  const inboxIds = Array.from(
    new Set(session.memberships.flatMap((m) => m.inboxIds)),
  );
  const { data: inboxRows } = inboxIds.length
    ? await supabase.from("inboxes").select("id, name").in("id", inboxIds)
    : { data: [] as Array<{ id: string; name: string }> };
  const inboxNameMap = new Map((inboxRows ?? []).map((i) => [i.id, i.name]));

  const memberships = session.memberships.map((m) => ({
    companyName: m.companyName,
    roleNames: m.roleNames,
    inboxNames: m.inboxIds
      .map((id) => inboxNameMap.get(id) || id.slice(0, 8))
      .filter(Boolean),
  }));

  return (
    <div>
      <PageHeader
        title="Mi perfil"
        description="Actualiza tu nombre y contraseña"
      />
      <ProfileForm
        email={session.email}
        fullName={session.fullName}
        memberships={memberships}
        showAssignedCompanies={showAssignedCompanies}
      />
    </div>
  );
}
