export const INBOX_COMPANY_COOKIE = "sofia-inbox-company-id";
export const INBOX_COMPANY_STORAGE_KEY = "sofia-inbox-company-id";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function pickPreferredCompanyId(
  companies: Array<{ id: string }>,
  preferred: string | null | undefined,
): string | null {
  if (!preferred) return null;
  return companies.some((c) => c.id === preferred) ? preferred : null;
}

/**
 * Company the inbox list is scoped to on first load. Always resolves to a
 * company when the user has one: without company_id the list query scans every
 * tenant under RLS and hits the 8s statement_timeout.
 */
export function resolveInitialCompanyId(
  companies: Array<{ id: string }>,
  preferred: string | null | undefined,
): string {
  return pickPreferredCompanyId(companies, preferred) ?? companies[0]?.id ?? "";
}

export function inboxCompanyCookieOptions() {
  return {
    path: "/",
    sameSite: "lax" as const,
    httpOnly: false,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}

/** Client-side cookie so the next SSR inbox load keeps the same company. */
export function writeInboxCompanyCookie(companyId: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${INBOX_COMPANY_COOKIE}=${encodeURIComponent(companyId)}; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}
