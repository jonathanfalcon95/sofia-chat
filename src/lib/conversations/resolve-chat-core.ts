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

/** Injected so this module stays importable from node:test. */
export type ResolveChatRepository = {
  findCompanyByGuid: (guid: string) => Promise<{ data: { id: string } | null }>;
  findCompanyById: (
    companyId: string,
  ) => Promise<{ data: { id: string } | null }>;
  listContactsByPhoneNumbers: (
    companyId: string,
    phoneNumbers: string[],
  ) => Promise<{ data: Array<{ id: string }> | null }>;
  listLatestConversationOfContacts: (
    companyId: string,
    contactIds: string[],
  ) => Promise<{ data: Array<{ id: string }> | null }>;
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
  repository: ResolveChatRepository,
): Promise<ResolveChatResult> {
  const digits = normalizePhoneDigits(phone);
  const guid = companyGuid.trim();
  if (!guid || !digits) return { ok: false, error: "not_found" };

  const { data: byGuid } = await repository.findCompanyByGuid(guid);

  let companyId = (byGuid?.id as string | undefined) ?? null;
  if (!companyId) {
    const { data: byId } = await repository.findCompanyById(guid);
    companyId = (byId?.id as string | undefined) ?? null;
  }

  if (!companyId) return { ok: false, error: "not_found" };

  if (!sessionCanViewCompany(session, companyId)) {
    return { ok: false, error: "not_found" };
  }

  const { data: contacts } = await repository.listContactsByPhoneNumbers(
    companyId,
    [`+${digits}`, digits],
  );

  const contactIds = (contacts ?? []).map((c) => c.id);
  if (contactIds.length === 0) return { ok: false, error: "not_found" };

  const { data: conversations } =
    await repository.listLatestConversationOfContacts(companyId, contactIds);

  const conversationId = conversations?.[0]?.id;
  if (!conversationId) return { ok: false, error: "not_found" };

  return { ok: true, conversationId, companyId };
}
