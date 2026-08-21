import { createClient } from "@/lib/supabase/server";
import type { AppSession } from "@/lib/rbac/session";
import {
  resolveChatByCompanyGuidAndPhone as resolveChatWithClient,
  type ResolveChatClient,
  type ResolveChatResult,
} from "./resolve-chat-core";

export type { ResolveChatResult } from "./resolve-chat-core";

export async function resolveChatByCompanyGuidAndPhone(
  session: AppSession,
  companyGuid: string,
  phone: string,
): Promise<ResolveChatResult> {
  const supabase = await createClient();
  return resolveChatWithClient(
    session,
    companyGuid,
    phone,
    supabase as unknown as ResolveChatClient,
  );
}
