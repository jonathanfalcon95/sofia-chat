/**
 * Internal post-login destinations. Rejects protocol-relative and off-site URLs.
 */
export function isSafeNextPath(
  value: string | null | undefined,
): value is string {
  if (!value) return false;

  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }

  if (!decoded.startsWith("/")) return false;
  if (decoded.startsWith("//")) return false;
  if (decoded.includes("://")) return false;
  if (decoded.includes("\\")) return false;
  if (/[\0\r\n]/.test(decoded)) return false;

  return (
    decoded === "/conversations" ||
    decoded.startsWith("/conversations/") ||
    decoded.startsWith("/c/")
  );
}

/** `/login` or `/login?next=` when the current path is an allowed deep link. */
export function loginUrlWithNext(pathname: string, search = ""): string {
  const withSearch = `${pathname}${search}`;
  const next = isSafeNextPath(withSearch)
    ? withSearch
    : isSafeNextPath(pathname)
      ? pathname
      : null;
  if (!next) return "/login";
  return `/login?next=${encodeURIComponent(next)}`;
}
