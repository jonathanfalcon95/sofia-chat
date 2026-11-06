import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containsPattern,
  isUuid,
  join,
  raw,
  sql,
  uuidList,
  where,
} from "./sql.ts";

test("values become parameters and never reach the text", () => {
  const evil = "x'; DROP TABLE t; --";
  const q = sql`select * from t where a = ${evil} and b = ${1} and c = ${null}`;
  assert.equal(q.text, "select * from t where a = @p0 and b = @p1 and c = @p2");
  assert.deepEqual(q.params, [evil, 1, null]);
});

test("nested fragments renumber their parameters", () => {
  const inner = sql`x = ${"a"} and y = ${"b"}`;
  const q = sql`select ${raw("id")} from t where z = ${"first"} and ${inner} and w = ${"last"}`;
  assert.equal(
    q.text,
    "select id from t where z = @p0 and x = @p1 and y = @p2 and w = @p3",
  );
  assert.deepEqual(q.params, ["first", "a", "b", "last"]);
});

test("Date and object values are rejected", () => {
  assert.throws(() => sql`select ${new Date() as never}`, /ISO strings/);
  assert.throws(() => sql`select ${{ a: 1 } as never}`, /JSON\.stringify/);
});

test("where skips missing parts and join keeps parameter order", () => {
  const q = where([sql`a = ${1}`, null, false, sql`b = ${2}`]);
  assert.equal(q.text, "WHERE a = @p0 AND b = @p1");
  assert.deepEqual(q.params, [1, 2]);
  assert.equal(where([null]).text, "");
  assert.equal(join([], " OR ").text, "");
});

test("uuidList sends one JSON parameter, however long the list", () => {
  const ids = Array.from({ length: 5000 }, () => "abc");
  const q = sql`select 1 where id in ${uuidList(ids)}`;
  assert.equal(q.params.length, 1);
  assert.deepEqual(JSON.parse(q.params[0] as string), ids);
});

test("isUuid accepts only well-formed ids", () => {
  assert.ok(isUuid("ABCDEF00-1111-4222-8333-444455556666"));
  for (const bad of ["", "x", "abcdef00-1111-4222-8333", 1, null, undefined]) {
    assert.equal(isUuid(bad), false);
  }
});

test("containsPattern escapes every T-SQL wildcard", () => {
  assert.equal(containsPattern("50%_a[b]"), "%50[%][_]a[[]b[]]%");
});
