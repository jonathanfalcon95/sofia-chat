import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationRow } from "./types.ts";
import {
  upsertConversationInList,
  mergeConversationListPage,
} from "./conversation-list.ts";

function row(
  id: string,
  companyId = "co-1",
  lastMessageAt = "2026-01-01T00:00:00Z",
): ConversationRow {
  return {
    id,
    company_id: companyId,
    inbox_id: "in-1",
    status: "open",
    last_message_at: lastMessageAt,
    last_message_preview: "hi",
    window_expires_at: null,
    assignee_id: null,
    unread_count: 0,
    contacts: {
      id: `ct-${id}`,
      name: "Ana",
      phone_number: "+584241889634",
    },
    inboxes: { name: "WA" },
    conversation_tags: [],
  };
}

test("upsertConversationInList inserts a missing chat by recency without jumping others", () => {
  const firstPage = [
    row("newer", "co-1", "2026-01-03T00:00:00Z"),
    row("older", "co-1", "2026-01-01T00:00:00Z"),
  ];
  const deepLinked = row("deep-link-chat", "co-1", "2026-01-02T00:00:00Z");
  const next = upsertConversationInList(firstPage, deepLinked);
  assert.deepEqual(
    next.map((c) => c.id),
    ["newer", "deep-link-chat", "older"],
  );
});

test("upsertConversationInList updates an already listed chat in place", () => {
  const listed = row("deep-link-chat", "co-1", "2026-01-01T00:00:00Z");
  const firstPage = [
    row("top", "co-1", "2026-01-02T00:00:00Z"),
    listed,
    row("other", "co-1", "2025-12-01T00:00:00Z"),
  ];
  const next = upsertConversationInList(firstPage, {
    ...listed,
    last_message_preview: "updated",
  });
  assert.equal(next.length, 3);
  assert.equal(next[0]?.id, "top");
  assert.equal(next[1]?.id, "deep-link-chat");
  assert.equal(next[1]?.last_message_preview, "updated");
  assert.equal(next.filter((c) => c.id === "deep-link-chat").length, 1);
});

test("mergeConversationListPage plus upsert keeps a missing deep-linked row after replace", () => {
  const firstPage = [
    row("a", "co-1", "2026-01-03T00:00:00Z"),
    row("b", "co-1", "2026-01-01T00:00:00Z"),
  ];
  const injected = row("deep-link-chat", "co-1", "2026-01-02T00:00:00Z");
  const merged = mergeConversationListPage([injected], firstPage);
  const kept = upsertConversationInList(merged, injected);
  assert.ok(kept.some((c) => c.id === "deep-link-chat"));
  assert.ok(kept.some((c) => c.id === "a"));
  assert.equal(kept.filter((c) => c.id === "deep-link-chat").length, 1);
});
