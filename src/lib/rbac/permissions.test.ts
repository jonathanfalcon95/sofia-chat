import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlatformPermission,
  isReservedRoleName,
  PLATFORM_PERMISSIONS,
  sanitizeRolePermissionCodes,
} from "./permissions.ts";

test("isPlatformPermission covers the locked catalog", () => {
  for (const code of PLATFORM_PERMISSIONS) {
    assert.equal(isPlatformPermission(code), true);
  }
  assert.equal(isPlatformPermission("users.manage"), false);
  assert.equal(isPlatformPermission("conversations.view"), false);
});

test("isReservedRoleName blocks Super Admin regardless of case/spaces", () => {
  assert.equal(isReservedRoleName("Super Admin"), true);
  assert.equal(isReservedRoleName("super admin"), true);
  assert.equal(isReservedRoleName("  SUPER ADMIN  "), true);
  assert.equal(isReservedRoleName("Admin"), false);
  assert.equal(isReservedRoleName("SuperAdmin"), false);
  assert.equal(isReservedRoleName("Agente"), false);
});

test("company admin cannot grant platform permissions on create", () => {
  const codes = sanitizeRolePermissionCodes(
    ["users.manage", "roles.manage", "error_logs.view", "companies.manage"],
    [],
    false,
  );
  assert.deepEqual(codes, ["users.manage"]);
});

test("company admin cannot revoke platform permissions already on the role", () => {
  const codes = sanitizeRolePermissionCodes(
    ["users.manage", "inboxes.manage"],
    ["roles.manage", "users.manage"],
    false,
  );
  assert.ok(codes.includes("users.manage"));
  assert.ok(codes.includes("inboxes.manage"));
  assert.ok(codes.includes("roles.manage"));
  assert.equal(codes.includes("error_logs.view"), false);
});

test("company admin cannot add error_logs.view or companies.manage to Admin", () => {
  const codes = sanitizeRolePermissionCodes(
    [
      "users.manage",
      "roles.manage",
      "error_logs.view",
      "companies.manage",
      "conversations.view",
    ],
    ["roles.manage", "users.manage"],
    false,
  );
  assert.ok(codes.includes("roles.manage"));
  assert.ok(codes.includes("users.manage"));
  assert.ok(codes.includes("conversations.view"));
  assert.equal(codes.includes("error_logs.view"), false);
  assert.equal(codes.includes("companies.manage"), false);
});

test("platform admin can grant and revoke platform permissions", () => {
  const granted = sanitizeRolePermissionCodes(
    ["roles.manage", "error_logs.view", "companies.manage", "users.manage"],
    ["roles.manage"],
    true,
  );
  assert.deepEqual(granted.sort(), [
    "companies.manage",
    "error_logs.view",
    "roles.manage",
    "users.manage",
  ]);

  const revoked = sanitizeRolePermissionCodes(
    ["users.manage"],
    ["roles.manage", "error_logs.view"],
    true,
  );
  assert.deepEqual(revoked, ["users.manage"]);
});

test("sanitizeRolePermissionCodes drops unknown codes and duplicates", () => {
  const codes = sanitizeRolePermissionCodes(
    ["users.manage", "users.manage", "not.a.permission", "conversations.view"],
    [],
    false,
  );
  assert.deepEqual(codes, ["users.manage", "conversations.view"]);
});
