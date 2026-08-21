/** Mirrors `normalizePhoneDigits` so this module stays importable from node:test. */
function normalizePhoneDigits(phone: string): string {
  let value = phone.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  return value.replace(/\D/g, "");
}

export type ResolveChatResult =
  | { ok: true; conversationId: string; companyId: string }
  | { ok: false; error: "not_found" };

export type ResolveChatSession = {
  isPlatformAdmin: boolean;
  memberships: Array<{ companyId: string; permissions: string[] }>;
};

export type ResolveChatClient = {
  from: (table: string) => {
    select: (columns: string) => ResolveChatQuery;
  };
};

type ResolveChatQuery = {
  eq: (column: string, value: string) => ResolveChatQuery;
  in: (column: string, values: string[]) => ResolveChatQuery;
  order: (
    column: string,
    options: { ascending: boolean; nullsFirst: boolean },
  ) => ResolveChatQuery;
  limit: (count: number) => ResolveChatQuery;
  maybeSingle: () => Promise<{ data: { id: string } | null }>;
  then: (
    onfulfilled: (value: { data: Array<{ id: string }> | null }) => unknown,
    onrejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

function sessionCanViewCompany(session: ResolveChatSession, companyId: string) {
  if (session.isPlatformAdmin) return true;
  return session.memberships.some(
    (m) =>
      m.companyId === companyId && m.permissions.includes("conversations.view"),
  );
}

export async function resolveChatByCompanyGuidAndPhone(
  session: ResolveChatSession,
  companyGuid: string,
  phone: string,
  client: ResolveChatClient,
): Promise<ResolveChatResult> {
  const digits = normalizePhoneDigits(phone);
  const guid = companyGuid.trim();
  if (!guid || !digits) return { ok: false, error: "not_found" };

  const supabase = client;

  const { data: byGuid } = await supabase
    .from("companies")
    .select("id")
    .eq("guid_company", guid)
    .maybeSingle();

  let companyId = (byGuid?.id as string | undefined) ?? null;
  if (!companyId) {
    const { data: byId } = await supabase
      .from("companies")
      .select("id")
      .eq("id", guid)
      .maybeSingle();
    companyId = (byId?.id as string | undefined) ?? null;
  }

  if (!companyId) return { ok: false, error: "not_found" };

  if (!sessionCanViewCompany(session, companyId)) {
    return { ok: false, error: "not_found" };
  }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id")
    .eq("company_id", companyId)
    .in("phone_number", [`+${digits}`, digits])
    .limit(5);

  const contactIds = (
    (contacts as Array<{ id: string }> | null) ?? []
  ).map((c) => c.id);
  if (contactIds.length === 0) return { ok: false, error: "not_found" };

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id")
    .eq("company_id", companyId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);

  const conversationId = (
    conversations as Array<{ id: string }> | null
  )?.[0]?.id;
  if (!conversationId) return { ok: false, error: "not_found" };

  return { ok: true, conversationId, companyId };
}
