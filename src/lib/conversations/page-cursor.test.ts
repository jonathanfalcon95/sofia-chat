import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePageCursor,
  encodePageCursor,
  olderThanCursorFilter,
} from "./page-cursor.ts";

const ID = "abcdef00-1111-4222-8333-444455556666";

test("a cursor survives encoding, with microseconds and an offset", () => {
  const ts = "2026-11-05T22:23:59.373371+00:00";
  assert.deepEqual(decodePageCursor(encodePageCursor(ts, ID)), { ts, id: ID });
});

test("decodePageCursor accepts a browser-made ISO timestamp", () => {
  const ts = "2026-11-05T22:23:59.373Z";
  assert.deepEqual(decodePageCursor(encodePageCursor(ts, ID)), { ts, id: ID });
});

test("decodePageCursor rejects values that are not cursors", () => {
  for (const value of ["", "not base64!", btoa("{}"), btoa('["a"]'), btoa("null")]) {
    assert.equal(decodePageCursor(value), null, value);
  }
});

test("decodePageCursor rejects anything that could escape the filter", () => {
  const injected = [
    encodePageCursor('2026-11-05T22:23:59Z",company_id.neq."x', ID),
    encodePageCursor("2026-11-05T22:23:59Z", `${ID}),id.not.is.null,(`),
    encodePageCursor("2026-11-05T22:23:59Z", "temp-123"),
    btoa(JSON.stringify([1, 2])),
  ];
  for (const value of injected) assert.equal(decodePageCursor(value), null);
});

test("olderThanCursorFilter breaks timestamp ties by id", () => {
  assert.equal(
    olderThanCursorFilter("created_at", { ts: "2026-11-05T22:23:59Z", id: ID }),
    `created_at.lt."2026-11-05T22:23:59Z",and(created_at.eq."2026-11-05T22:23:59Z",id.lt.${ID})`,
  );
});
