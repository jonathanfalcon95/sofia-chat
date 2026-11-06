import { NextResponse, type NextRequest } from "next/server";
import { isSafeNextPath, loginUrlWithNext } from "@/lib/auth/safe-next-path";
import {
  createSessionToken,
  readSessionToken,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  shouldRenewSession,
} from "@/lib/auth/session-token";
import { usesSqlServer } from "@/lib/db/backend";
import { toPublicUrl } from "@/lib/server-url";
import { updateSession } from "@/lib/supabase/middleware";

/** Checks the session token with no database call; `getCurrentUserId` checks revocation later. */
async function sqlServerSession(request: NextRequest) {
  const claims = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  const path = request.nextUrl.pathname;
  const isAuthPage = path.startsWith("/login");
  const isPublic =
    isAuthPage || path.startsWith("/api/webhooks") || path.startsWith("/api/auth");

  if (!claims && !isPublic) {
    return NextResponse.redirect(
      toPublicUrl(loginUrlWithNext(path, request.nextUrl.search), request),
    );
  }

  if (claims && isAuthPage) {
    const next = request.nextUrl.searchParams.get("next");
    return NextResponse.redirect(
      toPublicUrl(isSafeNextPath(next) ? next : "/conversations", request),
    );
  }

  const headers = new Headers(request.headers);
  headers.set("x-pathname", path);
  headers.set("x-search", request.nextUrl.search);
  const response = NextResponse.next({ request: { headers } });

  if (claims && shouldRenewSession(claims)) {
    response.cookies.set(
      SESSION_COOKIE,
      await createSessionToken(claims.userId, claims.sessionVersion),
      SESSION_COOKIE_OPTIONS,
    );
  }
  return response;
}

export async function proxy(request: NextRequest) {
  return usesSqlServer() ? sqlServerSession(request) : updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Skip static assets and high-volume webhook routes — each match was
     * invoking auth work and contributing to MIDDLEWARE_INVOCATION_TIMEOUT.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
