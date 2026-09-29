import { NextRequest, NextResponse } from "next/server";
import { loginUrlWithNext } from "@/lib/auth/safe-next-path";
import {
  INBOX_COMPANY_COOKIE,
  inboxCompanyCookieOptions,
} from "@/lib/conversations/inbox-company-preference";
import { resolveChatByCompanyGuidAndPhone } from "@/lib/conversations/resolve-chat-by-phone";
import { getAppSession } from "@/lib/rbac/session";
import { toPublicUrl } from "@/lib/server-url";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companyGuid: string; phone: string }> },
) {
  const { companyGuid, phone } = await params;
  const path = `/c/${companyGuid}/${phone}`;
  const session = await getAppSession();
  if (!session) {
    return NextResponse.redirect(toPublicUrl(loginUrlWithNext(path), request));
  }

  const result = await resolveChatByCompanyGuidAndPhone(
    session,
    companyGuid,
    phone,
  );
  if (!result.ok) {
    return NextResponse.redirect(toPublicUrl("/chat-not-found", request));
  }

  const response = NextResponse.redirect(
    toPublicUrl(`/conversations/${result.conversationId}`, request),
  );
  response.cookies.set(
    INBOX_COMPANY_COOKIE,
    result.companyId,
    inboxCompanyCookieOptions(),
  );
  return response;
}
