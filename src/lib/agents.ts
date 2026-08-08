import { createClient } from "@/lib/supabase/server";

export type CompanyAgent = {
  id: string;
  full_name: string | null;
  email: string;
  company_id: string;
};

/** Active company members that can be assigned chats (same company scope). */
export async function listCompanyAgents(): Promise<CompanyAgent[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("company_memberships")
    .select(
      `
      company_id,
      profiles ( id, full_name, email )
    `,
    )
    .eq("is_active", true);

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
