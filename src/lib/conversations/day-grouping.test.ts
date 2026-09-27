import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDayChip,
  getCalendarDayKey,
  groupMessagesByDay,
} from "./day-grouping.ts";
import type { MessageRow } from "./types.ts";

test("getCalendarDayKey returns YYYY-MM-DD", () => {
  const d = new Date(2026, 8, 25, 14, 30); // 25 Sep 2026
  assert.equal(getCalendarDayKey(d), "2026-09-25");
});

test("formatDayChip correctly formats Hoy, Ayer, weekday and older dates", () => {
  const ref = new Date(2026, 8, 25, 12, 0); // Friday Sep 25, 2026

  // Hoy
  assert.equal(formatDayChip(new Date(2026, 8, 25, 8, 0), ref), "Hoy");

  // Ayer
  assert.equal(formatDayChip(new Date(2026, 8, 24, 20, 0), ref), "Ayer");

  // 2 days ago (Wednesday)
  assert.equal(formatDayChip(new Date(2026, 8, 23, 10, 0), ref), "Miércoles");

  // 5 days ago (Sunday)
  assert.equal(formatDayChip(new Date(2026, 8, 20, 10, 0), ref), "Domingo");

  // Older in same year
  const olderSameYear = formatDayChip(new Date(2026, 7, 10, 10, 0), ref);
  assert.match(olderSameYear, /10 de agosto/i);

  // Different year
  const diffYear = formatDayChip(new Date(2025, 11, 24, 10, 0), ref);
  assert.match(diffYear, /24 de diciembre de 2025/i);
});

test("groupMessagesByDay groups messages by day key", () => {
  const ref = new Date(2026, 8, 25, 12, 0);
  const msgs: MessageRow[] = [
    {
      id: "1",
      direction: "inbound",
      type: "text",
      body: "Msg 1",
      status: "received",
      created_at: new Date(2026, 8, 24, 10, 0).toISOString(),
      template_name: null,
    },
    {
      id: "2",
      direction: "outbound",
      type: "text",
      body: "Msg 2",
      status: "delivered",
      created_at: new Date(2026, 8, 24, 15, 0).toISOString(),
      template_name: null,
    },
    {
      id: "3",
      direction: "inbound",
      type: "text",
      body: "Msg 3",
      status: "received",
      created_at: new Date(2026, 8, 25, 9, 0).toISOString(),
      template_name: null,
    },
  ];

  const groups = groupMessagesByDay(msgs, ref);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].dayLabel, "Ayer");
  assert.equal(groups[0].messages.length, 2);
  assert.equal(groups[1].dayLabel, "Hoy");
  assert.equal(groups[1].messages.length, 1);
});
