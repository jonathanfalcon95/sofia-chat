import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConversationRow } from "./types.ts";
import {
  upsertConversationInList,
  mergeConversationListPage,
} from "./conversation-list.ts";

function row(id: string, companyId = "co-1"): ConversationRow {
  return {
    id,
    company_id: companyId,
    inbox_id: "in-1",
    status: "open",
    last_message_at: "2026-01-01T00:00:00Z",
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

test("upsertConversationInList prepends a chat that is outside the first page", () => {
  const firstPage = Array.from({ length: 50 }, (_, i) => row(`page-${i}`));
  const deepLinked = row("deep-link-chat", "co-2");
  const next = upsertConversationInList(firstPage, deepLinked);
  assert.equal(next[0]?.id, "deep-link-chat");
  assert.equal(next.length, 51);
  assert.equal(next.filter((c) => c.id === "deep-link-chat").length, 1);
});

test("upsertConversationInList does not duplicate an already listed chat", () => {
  const listed = row("deep-link-chat");
  const firstPage = [listed, row("other")];
  const next = upsertConversationInList(firstPage, {
    ...listed,
    last_message_preview: "updated",
  });
  assert.equal(next.length, 2);
  assert.equal(next[0]?.last_message_preview, "updated");
  assert.equal(next.filter((c) => c.id === "deep-link-chat").length, 1);
});

test("mergeConversationListPage plus upsert keeps a deep-linked row after a list replace", () => {
  const firstPage = [row("a"), row("b")];
  const injected = row("deep-link-chat", "co-1");
  const merged = mergeConversationListPage([injected], firstPage);
  const kept = upsertConversationInList(merged, injected);
  assert.equal(kept[0]?.id, "deep-link-chat");
  assert.ok(kept.some((c) => c.id === "a"));
});
