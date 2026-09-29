import type { NextRequest } from "next/server";

function isInternalBindHost(host: string): boolean {
  return (
    host.startsWith("0.0.0.0") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::]")
  );
}

/**
 * Returns the canonical public origin (e.g. "https://agentesofiachat.site").
 * Prevents leaking internal reverse-proxy bind addresses like "0.0.0.0:21665" or "127.0.0.1" in redirects.
 */
export function getPublicOrigin(request?: Request | NextRequest): string {
  if (request) {
    const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
    const hostHeader = request.headers.get("host")?.trim();
    const candidateHost = forwardedHost || hostHeader;

    if (candidateHost) {
      if (
        process.env.NODE_ENV === "production" &&
        isInternalBindHost(candidateHost)
      ) {
        // Internal reverse proxy address leaked in production, skip and use configured public URL
      } else {
        const proto =
          request.headers.get("x-forwarded-proto")?.trim() ||
          (request.url.startsWith("https:") ? "https" : "http");
        return `${proto}://${candidateHost}`;
      }
    }
  }

  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }

  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/\/+$/, "")}`;
  }

  return "https://agentesofiachat.site";
}

/**
 * Constructs an absolute public URL pointing to `path`.
 * Guarantees that the hostname is the public external domain, not an internal bind address.
 */
export function toPublicUrl(path: string, request?: Request | NextRequest): URL {
  const origin = getPublicOrigin(request);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, origin);
}
