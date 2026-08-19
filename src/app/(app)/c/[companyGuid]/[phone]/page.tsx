import { redirect } from "next/navigation";
import { ChatNotFound } from "@/components/conversations/chat-not-found";
import { loginUrlWithNext } from "@/lib/auth/safe-next-path";
import { resolveChatByCompanyGuidAndPhone } from "@/lib/conversations/resolve-chat-by-phone";
import { getAppSession } from "@/lib/rbac/session";

export default async function ChatDeepLinkPage({
  params,
}: {
  params: Promise<{ companyGuid: string; phone: string }>;
}) {
  const { companyGuid, phone } = await params;
  const session = await getAppSession();
  if (!session) {
    redirect(loginUrlWithNext(`/c/${companyGuid}/${phone}`));
  }

  const result = await resolveChatByCompanyGuidAndPhone(
    session,
    companyGuid,
    phone,
  );
  if (result.ok) {
    redirect(`/conversations/${result.conversationId}`);
  }

  return <ChatNotFound />;
}
