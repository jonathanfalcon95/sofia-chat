import { normalizePhoneDigits } from "@/lib/conversations/phone-digits";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionHasPermission,
} from "@/lib/rbac/session";

export type SofiaConversationContext = {
  guidCompany: string;
  botPhone: string;
  customerPhone: string;
  contactName: string | null;
  accountName: string | null;
};

type LoadResult =
  | { ok: true; ctx: SofiaConversationContext }
  | { ok: false; status: number; error: string };

export async function loadSofiaConversation(
  conversationId: string,
): Promise<LoadResult> {
  if (!conversationId.trim()) {
    return { ok: false, status: 400, error: "conversation_id_required" };
  }

  const session = await getAppSession();
  if (!session) return { ok: false, status: 401, error: "unauthorized" };

  const supabase = await createClient();
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select(
      `
      id, company_id, inbox_id,
      inboxes ( phone_number, ycloud_account_id ),
      contacts ( phone_number, name )
    `,
    )
    .eq("id", conversationId)
    .single();

  if (error || !conversation) {
    return { ok: false, status: 404, error: "conversation_not_found" };
  }

  if (
    !sessionHasPermission(
      session,
      conversation.company_id as string,
      "conversations.reply",
    )
  ) {
    return {
      ok: false,
      status: 403,
      error: "No tienes permiso para controlar Sofia en esta conversación.",
    };
  }

  const inbox = firstRelation(conversation.inboxes);
  const contact = firstRelation(conversation.contacts);
  const botPhone = normalizePhoneDigits(textField(inbox, "phone_number"));
  const customerPhone = normalizePhoneDigits(textField(contact, "phone_number"));
  if (!botPhone || !customerPhone) {
    return { ok: false, status: 400, error: "missing_phones" };
  }

  const admin = createAdminClient();
  const { data: company, error: companyError } = await admin
    .from("companies")
    .select("guid_company")
    .eq("id", conversation.company_id as string)
    .maybeSingle();
  if (companyError) {
    return { ok: false, status: 500, error: companyError.message };
  }
  const guidCompany =
    (company?.guid_company as string | null)?.trim() ||
    (conversation.company_id as string);
  if (!guidCompany) {
    return { ok: false, status: 400, error: "missing_guid_company" };
  }

  let accountName: string | null = null;
  const accountId = textField(inbox, "ycloud_account_id");
  if (accountId) {
    const { data: account, error: accountError } = await admin
      .from("ycloud_accounts")
      .select("name")
      .eq("id", accountId)
      .maybeSingle();
    if (accountError) {
      return { ok: false, status: 500, error: accountError.message };
    }
    accountName = (account?.name as string | null) ?? null;
  }

  return {
    ok: true,
    ctx: {
      guidCompany,
      botPhone,
      customerPhone,
      contactName: textField(contact, "name") || null,
      accountName,
    },
  };
}

function firstRelation(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

function textField(row: Record<string, unknown> | null, key: string) {
  const value = row?.[key];
  return typeof value === "string" ? value : "";
}
