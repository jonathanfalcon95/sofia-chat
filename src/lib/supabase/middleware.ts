import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isSafeNextPath, loginUrlWithNext } from "@/lib/auth/safe-next-path";

function nextWithPathname(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-search", request.nextUrl.search);
  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

function redirectPreservingCookies(
  supabaseResponse: NextResponse,
  location: URL,
) {
  const redirectResponse = NextResponse.redirect(location);
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie);
  });
  return redirectResponse;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = nextWithPathname(request);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = nextWithPathname(request);
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isAuthPage = path.startsWith("/login");
  const isPublic =
    isAuthPage ||
    path.startsWith("/api/webhooks") ||
    path.startsWith("/auth");

  if (!user && !isPublic) {
    const loginPath = loginUrlWithNext(path, request.nextUrl.search);
    return redirectPreservingCookies(
      supabaseResponse,
      new URL(loginPath, request.url),
    );
  }

  if (user && isAuthPage) {
    const next = request.nextUrl.searchParams.get("next");
    const destination = isSafeNextPath(next) ? next : "/conversations";
    return redirectPreservingCookies(
      supabaseResponse,
      new URL(destination, request.url),
    );
  }

  return supabaseResponse;
}
