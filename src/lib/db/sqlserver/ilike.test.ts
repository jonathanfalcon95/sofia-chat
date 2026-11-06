import assert from "node:assert/strict";
import { test } from "node:test";
import { ilikeToLike } from "./ilike.ts";

test("keeps the wildcards the pattern already has", () => {
  assert.equal(ilikeToLike("%ana%"), "%ana%");
  assert.equal(ilikeToLike("a_a"), "a_a");
});

test("reads an asterisk as PostgREST does", () => {
  assert.equal(ilikeToLike("%a*b%"), "%a%b%");
});

test("keeps a bracket literal, as it is in Postgres", () => {
  assert.equal(ilikeToLike("%[a]%"), "%[[]a]%");
});
