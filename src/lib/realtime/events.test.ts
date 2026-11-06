import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cursorIsStale,
  eventsAfter,
  eventVisibleTo,
  pushToRing,
  type RealtimeEvent,
} from "./events.ts";

function event(seq: number, table: RealtimeEvent["table"], inboxId: string | null): RealtimeEvent {
  return { seq, table, eventType: "INSERT", companyId: "co", inboxId, row: { id: `r${seq}` } };
}

const member = { isPlatformAdmin: false, viewableInboxIds: ["in-a"] };

test("a user never receives events from an inbox they can't reach", () => {
  assert.equal(eventVisibleTo(event(1, "messages", "in-z"), member), false);
  assert.equal(eventVisibleTo(event(1, "conversations", "in-z"), member), false);
  assert.equal(eventVisibleTo(event(1, "messages", null), member), false);
});

test("a viewable inbox delivers both kinds of event", () => {
  assert.equal(eventVisibleTo(event(1, "messages", "in-a"), member), true);
  assert.equal(eventVisibleTo(event(1, "conversations", "in-a"), member), true);
});

test("a platform admin sees everything", () => {
  const admin = { isPlatformAdmin: true, viewableInboxIds: [] };
  assert.equal(eventVisibleTo(event(1, "conversations", "in-z"), admin), true);
});

test("a user with no inboxes sees nothing", () => {
  const none = { isPlatformAdmin: false, viewableInboxIds: [] };
  assert.equal(eventVisibleTo(event(1, "messages", "in-a"), none), false);
});

test("the ring returns only newer events and flags a client left behind", () => {
  const ring: RealtimeEvent[] = [];
  for (let seq = 1; seq <= 2005; seq++) pushToRing(ring, event(seq, "messages", "in-a"));
  assert.equal(ring.length, 2000);
  assert.deepEqual(eventsAfter(ring, 2003).map((e) => e.seq), [2004, 2005]);
  assert.equal(cursorIsStale(ring, 2003), false);
  assert.equal(cursorIsStale(ring, 1), true);
});
