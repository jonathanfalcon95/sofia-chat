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

/** Put a deep-linked chat at the front of the list even if it is outside the first page. */
export function upsertConversationInList(
  list: ConversationRow[],
  row: ConversationRow,
): ConversationRow[] {
  const rest = list.filter((c) => c.id !== row.id);
  return [row, ...rest];
}
