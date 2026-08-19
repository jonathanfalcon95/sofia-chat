import { createClient } from "@/lib/supabase/server";
import {
  sessionHasPermission,
  type AppSession,
} from "@/lib/rbac/session";
import { normalizePhoneDigits } from "./phone-digits";

export type ResolveChatResult =
  | { ok: true; conversationId: string; companyId: string }
  | { ok: false; error: "not_found" };

export async function resolveChatByCompanyGuidAndPhone(
  session: AppSession,
  companyGuid: string,
  phone: string,
): Promise<ResolveChatResult> {
  const digits = normalizePhoneDigits(phone);
  const guid = companyGuid.trim();
  if (!guid || !digits) return { ok: false, error: "not_found" };

  const supabase = await createClient();

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

  if (!sessionHasPermission(session, companyId, "conversations.view")) {
    return { ok: false, error: "not_found" };
  }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id")
    .eq("company_id", companyId)
    .in("phone_number", [`+${digits}`, digits])
    .limit(5);

  const contactIds = (contacts ?? []).map((c) => c.id as string);
  if (contactIds.length === 0) return { ok: false, error: "not_found" };

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id")
    .eq("company_id", companyId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);

  const conversationId = conversations?.[0]?.id as string | undefined;
  if (!conversationId) return { ok: false, error: "not_found" };

  return { ok: true, conversationId, companyId };
}
