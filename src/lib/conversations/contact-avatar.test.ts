import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarColor, avatarInitials } from "./contact-avatar.ts";

test("avatarInitials takes the first letters of the first two words", () => {
  assert.equal(avatarInitials("Ana María Pérez"), "AM");
  assert.equal(avatarInitials("ana"), "A");
  assert.equal(avatarInitials("  josé   luis "), "JL");
});

test("avatarInitials handles accents and skips emoji", () => {
  assert.equal(avatarInitials("Ñandú Ávila"), "ÑÁ");
  assert.equal(avatarInitials("🌟 Clínica Sur"), "CS");
});

test("avatarInitials returns null when there are no letters", () => {
  assert.equal(avatarInitials("+58 424 188 9634"), null);
  assert.equal(avatarInitials(""), null);
  assert.equal(avatarInitials(null), null);
  assert.equal(avatarInitials(undefined), null);
});

test("avatarColor is stable per seed", () => {
  assert.equal(avatarColor("contact-1"), avatarColor("contact-1"));
  assert.match(avatarColor(""), /^#[0-9a-f]{6}$/);
});
