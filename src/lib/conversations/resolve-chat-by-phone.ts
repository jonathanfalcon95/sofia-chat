import { getUserDb } from "@/lib/db/client";
import {
  findCompanyByGuid,
  findCompanyById,
  listContactsByPhoneNumbers,
  listLatestConversationOfContacts,
} from "@/lib/db/repos/conversations";
import type { AppSession } from "@/lib/rbac/session";
import {
  resolveChatByCompanyGuidAndPhone as resolveChatWithRepository,
  type ResolveChatResult,
} from "./resolve-chat-core";

export type { ResolveChatResult } from "./resolve-chat-core";

export async function resolveChatByCompanyGuidAndPhone(
  session: AppSession,
  companyGuid: string,
  phone: string,
): Promise<ResolveChatResult> {
  const db = await getUserDb();
  return resolveChatWithRepository(session, companyGuid, phone, {
    findCompanyByGuid: (guid) => findCompanyByGuid(db, guid),
    findCompanyById: (companyId) => findCompanyById(db, companyId),
    listContactsByPhoneNumbers: (companyId, phoneNumbers) =>
      listContactsByPhoneNumbers(db, companyId, phoneNumbers),
    listLatestConversationOfContacts: (companyId, contactIds) =>
      listLatestConversationOfContacts(db, companyId, contactIds),
  });
}
