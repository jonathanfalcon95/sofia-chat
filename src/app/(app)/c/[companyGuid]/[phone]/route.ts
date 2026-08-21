import { NextRequest, NextResponse } from "next/server";
import { loginUrlWithNext } from "@/lib/auth/safe-next-path";
import {
  INBOX_COMPANY_COOKIE,
  inboxCompanyCookieOptions,
} from "@/lib/conversations/inbox-company-preference";
import { resolveChatByCompanyGuidAndPhone } from "@/lib/conversations/resolve-chat-by-phone";
import { getAppSession } from "@/lib/rbac/session";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companyGuid: string; phone: string }> },
) {
  const { companyGuid, phone } = await params;
  const path = `/c/${companyGuid}/${phone}`;
  const session = await getAppSession();
  if (!session) {
    return NextResponse.redirect(new URL(loginUrlWithNext(path), request.url));
  }

  const result = await resolveChatByCompanyGuidAndPhone(
    session,
    companyGuid,
    phone,
  );
  if (!result.ok) {
    return NextResponse.redirect(new URL("/chat-not-found", request.url));
  }

  const response = NextResponse.redirect(
    new URL(`/conversations/${result.conversationId}`, request.url),
  );
  response.cookies.set(
    INBOX_COMPANY_COOKIE,
    result.companyId,
    inboxCompanyCookieOptions(),
  );
  return response;
}
