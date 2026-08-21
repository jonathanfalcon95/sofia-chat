import type { ConversationRow } from "./types";

/** Merge a refreshed first page into an already-loaded list without dropping older pages. */
export function mergeConversationListPage(
  prev: ConversationRow[],
  firstPage: ConversationRow[],
): ConversationRow[] {
  const firstIds = new Set(firstPage.map((c) => c.id));
  const older = prev.filter((c) => !firstIds.has(c.id));
  return [...firstPage, ...older];
}

/** Append a page of older conversations, skipping duplicates. */
export function appendConversationListPage(
  prev: ConversationRow[],
  nextPage: ConversationRow[],
): ConversationRow[] {
  const seen = new Set(prev.map((c) => c.id));
  const appended = nextPage.filter((c) => !seen.has(c.id));
  return [...prev, ...appended];
}

/**
 * Ensure a deep-linked chat is in the list without jumping already-visible rows.
 * - If present: update fields in place (preserve order).
 * - If missing: insert by last_message_at desc so the list stays sorted.
 */
export function upsertConversationInList(
  list: ConversationRow[],
  row: ConversationRow,
): ConversationRow[] {
  const idx = list.findIndex((c) => c.id === row.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = { ...list[idx], ...row };
    return next;
  }

  const rowTime = row.last_message_at
    ? Date.parse(row.last_message_at)
    : Number.NEGATIVE_INFINITY;
  let insertAt = list.findIndex((c) => {
    const t = c.last_message_at
      ? Date.parse(c.last_message_at)
      : Number.NEGATIVE_INFINITY;
    return t < rowTime;
  });
  if (insertAt < 0) insertAt = list.length;
  const next = list.slice();
  next.splice(insertAt, 0, row);
  return next;
}
