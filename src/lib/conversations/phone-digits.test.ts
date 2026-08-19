import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhoneDigits } from "./phone-digits.ts";

test("normalizePhoneDigits strips plus, spaces, and encoding to the same digits", () => {
  assert.equal(normalizePhoneDigits("+584266330794"), "584266330794");
  assert.equal(normalizePhoneDigits("584266330794"), "584266330794");
  assert.equal(normalizePhoneDigits("%2B584266330794"), "584266330794");
  assert.equal(normalizePhoneDigits(" +58 426 633 0794 "), "584266330794");
});

test("normalizePhoneDigits returns empty for non-numeric input", () => {
  assert.equal(normalizePhoneDigits(""), "");
  assert.equal(normalizePhoneDigits("abc"), "");
});
