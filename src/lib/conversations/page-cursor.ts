/** Position in a list ordered by a timestamp and then id, both descending. */
export type PageCursor = { ts: string; id: string };

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque to clients, so the database behind the cursor can change. */
export function encodePageCursor(ts: string, id: string): string {
  return btoa(JSON.stringify([ts, id]));
}

/**
 * Null for anything malformed. The values end up inside a filter string, so nothing that fails
 * these patterns may get through.
 */
export function decodePageCursor(value: string): PageCursor | null {
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ts, id] = parsed;
    if (typeof ts !== "string" || typeof id !== "string") return null;
    if (!TIMESTAMP.test(ts) || !UUID.test(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/** PostgREST filter for rows after the cursor; `id` breaks ties on the timestamp. */
export function olderThanCursorFilter(
  column: string,
  cursor: PageCursor,
): string {
  const ts = `"${cursor.ts}"`;
  return `${column}.lt.${ts},and(${column}.eq.${ts},id.lt.${cursor.id})`;
}
