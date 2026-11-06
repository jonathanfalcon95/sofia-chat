import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAccess,
  hasCompanyAccess,
  hasInboxAccess,
  hasPermission,
  inboxesWithPermission,
  scope,
  type AccessRows,
} from "./access.ts";

const base: AccessRows = {
  userId: "user",
  isPlatformAdmin: false,
  memberships: [{ id: "m-a", companyId: "co-a" }],
  permissions: [{ membershipId: "m-a", code: "conversations.view" }],
  membershipInboxes: [{ membershipId: "m-a", inboxId: "in-a1" }],
  inboxes: [
    { id: "in-a1", companyId: "co-a" },
    { id: "in-a2", companyId: "co-a" },
    { id: "in-b1", companyId: "co-b" },
    { id: "pool", companyId: null },
  ],
};

test("a member reaches only assigned inboxes of their company", () => {
  const access = buildAccess(base);
  assert.deepEqual(access.inboxIds, ["in-a1"]);
  assert.equal(hasCompanyAccess(access, "co-a"), true);
  assert.equal(hasCompanyAccess(access, "co-b"), false);
  assert.equal(hasInboxAccess(access, "in-a2"), false);
  assert.equal(hasInboxAccess(access, "in-b1"), false);
  assert.equal(hasInboxAccess(access, "pool"), false);
});

test("inboxes.manage reaches every inbox of that company and no other", () => {
  const access = buildAccess({
    ...base,
    permissions: [{ membershipId: "m-a", code: "inboxes.manage" }],
    membershipInboxes: [],
  });
  assert.deepEqual(access.inboxIds, ["in-a1", "in-a2"]);
});

test("a stale link to another company's inbox grants nothing", () => {
  const access = buildAccess({
    ...base,
    membershipInboxes: [{ membershipId: "m-a", inboxId: "in-b1" }],
  });
  assert.deepEqual(access.inboxIds, []);
});

test("permissions don't leak between companies", () => {
  const access = buildAccess({
    ...base,
    memberships: [
      { id: "m-a", companyId: "co-a" },
      { id: "m-b", companyId: "co-b" },
    ],
    permissions: [{ membershipId: "m-b", code: "users.manage" }],
  });
  assert.equal(hasPermission(access, "co-b", "users.manage"), true);
  assert.equal(hasPermission(access, "co-a", "users.manage"), false);
  assert.equal(hasPermission(access, null, "users.manage"), false);
});

test("a platform admin reaches everything, including unassigned inboxes", () => {
  const access = buildAccess({
    ...base,
    isPlatformAdmin: true,
    memberships: [],
    permissions: [],
    membershipInboxes: [],
  });
  assert.equal(hasCompanyAccess(access, "co-b"), true);
  assert.equal(hasPermission(access, "co-b", "anything"), true);
  assert.equal(hasInboxAccess(access, "pool"), true);
  assert.equal(scope.company(access, "company_id").text, "1 = 1");
});

test("conversations need the inbox and conversations.view on its company", () => {
  const without = buildAccess({ ...base, permissions: [] });
  assert.deepEqual(inboxesWithPermission(without, "conversations.view"), []);
  assert.equal(scope.conversationsRead(without, "c.inbox_id").text, "1 = 0");

  const allowed = buildAccess(base);
  const clause = scope.conversationsRead(allowed, "c.inbox_id");
  assert.match(clause.text, /^c\.inbox_id IN /);
  assert.deepEqual(JSON.parse(clause.params[0] as string), ["in-a1"]);
});

test("a user with no memberships matches nothing, never everything", () => {
  const access = buildAccess({
    ...base,
    memberships: [],
    permissions: [],
    membershipInboxes: [],
  });
  assert.equal(scope.company(access, "company_id").text, "1 = 0");
  assert.equal(scope.inbox(access, "inbox_id").text, "1 = 0");
  assert.equal(scope.ticketsRead(access, "company_id").text, "1 = 0");
  assert.equal(scope.errorLogs(access).text, "1 = 0");
});
