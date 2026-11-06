import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterFailedLogin,
  isLocked,
  MAX_FAILED_LOGINS,
  normalizeEmail,
  passwordProblem,
} from "./login-policy.ts";

const NOW = new Date("2026-11-06T00:00:00.000Z");

test("failures count up and the limit locks the account for a while", () => {
  assert.deepEqual(afterFailedLogin(0, NOW), { failedCount: 1, lockedUntil: null });
  const locked = afterFailedLogin(MAX_FAILED_LOGINS - 1, NOW);
  assert.equal(locked.failedCount, 0);
  assert.ok(isLocked(locked.lockedUntil, NOW));
  assert.equal(isLocked(locked.lockedUntil, new Date(NOW.getTime() + 16 * 60_000)), false);
});

test("no lock date means unlocked", () => {
  assert.equal(isLocked(null, NOW), false);
  assert.equal(isLocked(undefined, NOW), false);
});

test("password policy rejects short and over-long passwords", () => {
  assert.match(passwordProblem("corta") ?? "", /al menos/);
  assert.match(passwordProblem("ñ".repeat(40)) ?? "", /72 bytes/);
  assert.equal(passwordProblem("una-clave-correcta"), null);
});

test("emails compare without case or surrounding spaces", () => {
  assert.equal(normalizeEmail("  Ana@Empresa.COM "), "ana@empresa.com");
});
