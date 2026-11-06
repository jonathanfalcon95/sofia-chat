import { getUserDb } from "@/lib/db/client";
import { listActiveMembersByRoleName } from "@/lib/db/repos/memberships";

export type CompanyAgent = {
  id: string;
  full_name: string | null;
  email: string;
  company_id: string;
};

/** Active members with role name "Agente" (chat assignees). */
export async function listCompanyAgents(
  companyId?: string,
): Promise<CompanyAgent[]> {
  const db = await getUserDb();
  const { data, error } = await listActiveMembersByRoleName(
    db,
    "Agente",
    companyId,
  );
  if (error || !data) return [];

  const agents: CompanyAgent[] = [];
  for (const row of data) {
    const profile = Array.isArray(row.profiles)
      ? row.profiles[0]
      : row.profiles;
    if (!profile?.id) continue;
    agents.push({
      id: profile.id as string,
      full_name: (profile.full_name as string | null) ?? null,
      email: profile.email as string,
      company_id: row.company_id as string,
    });
  }

  // Dedupe by user+company
  const seen = new Set<string>();
  return agents.filter((a) => {
    const key = `${a.company_id}:${a.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Active members with role name "Soporte" (ticket assignees). */
export async function listCompanySupportAgents(
  companyId?: string,
): Promise<CompanyAgent[]> {
  const db = await getUserDb();
  const { data, error } = await listActiveMembersByRoleName(
    db,
    "Soporte",
    companyId,
  );
  if (error || !data) return [];

  const agents: CompanyAgent[] = [];
  for (const row of data) {
    const profile = Array.isArray(row.profiles)
      ? row.profiles[0]
      : row.profiles;
    if (!profile?.id) continue;
    agents.push({
      id: profile.id as string,
      full_name: (profile.full_name as string | null) ?? null,
      email: profile.email as string,
      company_id: row.company_id as string,
    });
  }

  const seen = new Set<string>();
  return agents.filter((a) => {
    const key = `${a.company_id}:${a.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
