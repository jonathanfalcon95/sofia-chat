import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxVisibility, visibleInboxesFilter } from "./visible-inboxes.ts";

test("inboxVisibility is null for platform admins", () => {
  assert.equal(inboxVisibility({ isPlatformAdmin: true, memberships: [] }), null);
});

test("inboxes.manage sees the whole company; others only assigned inboxes", () => {
  const visibility = inboxVisibility({
    isPlatformAdmin: false,
    memberships: [
      {
        companyId: "admin-co",
        permissions: ["inboxes.manage", "conversations.view"],
        inboxIds: ["ignored"],
      },
      {
        companyId: "agent-co",
        permissions: ["conversations.view"],
        inboxIds: ["in-1", "in-2"],
      },
    ],
  });
  assert.deepEqual(visibility, {
    managedCompanyIds: ["admin-co"],
    assignedInboxIds: ["in-1", "in-2"],
    conversationCompanyIds: ["admin-co", "agent-co"],
  });
});

test("conversations.view is required to read conversations", () => {
  const visibility = inboxVisibility({
    isPlatformAdmin: false,
    memberships: [
      { companyId: "co", permissions: ["inboxes.manage"], inboxIds: [] },
    ],
  });
  assert.deepEqual(visibility?.conversationCompanyIds, []);
  assert.deepEqual(visibility?.managedCompanyIds, ["co"]);
});

test("visibleInboxesFilter combines companies and assigned inboxes", () => {
  assert.equal(
    visibleInboxesFilter({
      managedCompanyIds: ["a", "b"],
      assignedInboxIds: ["c"],
      conversationCompanyIds: [],
    }),
    "company_id.in.(a,b),id.in.(c)",
  );
});

test("visibleInboxesFilter is null when no inbox is visible", () => {
  assert.equal(
    visibleInboxesFilter({
      managedCompanyIds: [],
      assignedInboxIds: [],
      conversationCompanyIds: [],
    }),
    null,
  );
});
