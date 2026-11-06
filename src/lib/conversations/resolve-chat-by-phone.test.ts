import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveChatByCompanyGuidAndPhone,
  type ResolveChatRepository,
  type ResolveChatSession,
} from "./resolve-chat-core.ts";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "da763379-c95f-4501-8996-b8c191d9344d";
const GUID = "e52ca65d-d58b-4973-860f-25086ff309a9";

function session(overrides: Partial<ResolveChatSession> = {}): ResolveChatSession {
  return {
    userId: "user-1",
    email: "info@provesalud.com",
    fullName: "Admin",
    isPlatformAdmin: false,
    memberships: [
      {
        id: "m1",
        companyId: COMPANY_ID,
        companyName: "Provesalud",
        roleNames: ["Admin"],
        permissions: ["conversations.view"],
        inboxIds: [],
      },
    ],
    ...overrides,
  };
}

type Call = [operation: string, ...args: unknown[]];

/** Answers each repository call with the next queued response and records it. */
function queuedRepository(
  responses: Array<{ data: unknown }>,
): ResolveChatRepository & { calls: Call[] } {
  let i = 0;
  const calls: Call[] = [];
  const answer = <T,>(call: Call) => {
    calls.push(call);
    return Promise.resolve((responses[i++] ?? { data: null }) as { data: T });
  };
  return {
    calls,
    findCompanyByGuid: (guid) => answer(["findCompanyByGuid", guid]),
    findCompanyById: (companyId) => answer(["findCompanyById", companyId]),
    listContactsByPhoneNumbers: (companyId, phoneNumbers) =>
      answer(["listContactsByPhoneNumbers", companyId, phoneNumbers]),
    listLatestConversationOfContacts: (companyId, contactIds) =>
      answer(["listLatestConversationOfContacts", companyId, contactIds]),
  };
}

test("resolve returns not_found for empty guid or non-numeric phone", async () => {
  const repository = queuedRepository([]);
  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(session(), "  ", "584241889634", repository),
    { ok: false, error: "not_found" },
  );
  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(session(), GUID, "abc", repository),
    { ok: false, error: "not_found" },
  );
  assert.deepEqual(repository.calls, []);
});

test("resolve finds company by guid_company and latest chat for +digits or digits", async () => {
  const repository = queuedRepository([
    { data: { id: COMPANY_ID } },
    { data: [{ id: CONTACT_ID }] },
    { data: [{ id: CONV_ID }] },
  ]);
  const result = await resolveChatByCompanyGuidAndPhone(
    session(),
    GUID,
    "584241889634",
    repository,
  );
  assert.deepEqual(result, {
    ok: true,
    conversationId: CONV_ID,
    companyId: COMPANY_ID,
  });
  assert.deepEqual(repository.calls, [
    ["findCompanyByGuid", GUID],
    [
      "listContactsByPhoneNumbers",
      COMPANY_ID,
      ["+584241889634", "584241889634"],
    ],
    ["listLatestConversationOfContacts", COMPANY_ID, [CONTACT_ID]],
  ]);
});

test("resolve falls back to companies.id when guid_company misses", async () => {
  const repository = queuedRepository([
    { data: null },
    { data: { id: COMPANY_ID } },
    { data: [{ id: CONTACT_ID }] },
    { data: [{ id: CONV_ID }] },
  ]);
  const result = await resolveChatByCompanyGuidAndPhone(
    session(),
    COMPANY_ID,
    "+58 424 188 9634",
    repository,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.conversationId, CONV_ID);
    assert.equal(result.companyId, COMPANY_ID);
  }
  assert.deepEqual(repository.calls.slice(0, 2), [
    ["findCompanyByGuid", COMPANY_ID],
    ["findCompanyById", COMPANY_ID],
  ]);
});

test("resolve hides missing company, permission, contact, and chat as not_found", async () => {
  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session(),
      GUID,
      "584241889634",
      queuedRepository([{ data: null }, { data: null }]),
    ),
    { ok: false, error: "not_found" },
  );

  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session({ memberships: [] }),
      GUID,
      "584241889634",
      queuedRepository([{ data: { id: COMPANY_ID } }]),
    ),
    { ok: false, error: "not_found" },
  );

  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session(),
      GUID,
      "584241889634",
      queuedRepository([{ data: { id: COMPANY_ID } }, { data: [] }]),
    ),
    { ok: false, error: "not_found" },
  );

  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session(),
      GUID,
      "584241889634",
      queuedRepository([
        { data: { id: COMPANY_ID } },
        { data: [{ id: CONTACT_ID }] },
        { data: [] },
      ]),
    ),
    { ok: false, error: "not_found" },
  );
});
