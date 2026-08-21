import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveChatByCompanyGuidAndPhone,
  type ResolveChatClient,
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

function queuedClient(
  responses: Array<{ data: unknown }>,
): ResolveChatClient {
  let i = 0;
  return {
    from() {
      const res = responses[i++] ?? { data: null };
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      builder.select = self;
      builder.eq = self;
      builder.in = self;
      builder.order = self;
      builder.limit = self;
      builder.maybeSingle = () => {
        const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
        return Promise.resolve({ data, error: null });
      };
      builder.then = (
        onFulfilled: (value: { data: unknown; error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: res.data, error: null }).then(onFulfilled, onRejected);
      return builder;
    },
  };
}

test("resolve returns not_found for empty guid or non-numeric phone", async () => {
  const client = queuedClient([]);
  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(session(), "  ", "584241889634", client),
    { ok: false, error: "not_found" },
  );
  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(session(), GUID, "abc", client),
    { ok: false, error: "not_found" },
  );
});

test("resolve finds company by guid_company and latest chat for +digits or digits", async () => {
  const client = queuedClient([
    { data: { id: COMPANY_ID } },
    { data: [{ id: CONTACT_ID }] },
    { data: [{ id: CONV_ID }] },
  ]);
  const result = await resolveChatByCompanyGuidAndPhone(
    session(),
    GUID,
    "584241889634",
    client,
  );
  assert.deepEqual(result, {
    ok: true,
    conversationId: CONV_ID,
    companyId: COMPANY_ID,
  });
});

test("resolve falls back to companies.id when guid_company misses", async () => {
  const client = queuedClient([
    { data: null },
    { data: { id: COMPANY_ID } },
    { data: [{ id: CONTACT_ID }] },
    { data: [{ id: CONV_ID }] },
  ]);
  const result = await resolveChatByCompanyGuidAndPhone(
    session(),
    COMPANY_ID,
    "+58 424 188 9634",
    client,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.conversationId, CONV_ID);
    assert.equal(result.companyId, COMPANY_ID);
  }
});

test("resolve hides missing company, permission, contact, and chat as not_found", async () => {
  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session(),
      GUID,
      "584241889634",
      queuedClient([{ data: null }, { data: null }]),
    ),
    { ok: false, error: "not_found" },
  );

  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session({ memberships: [] }),
      GUID,
      "584241889634",
      queuedClient([{ data: { id: COMPANY_ID } }]),
    ),
    { ok: false, error: "not_found" },
  );

  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session(),
      GUID,
      "584241889634",
      queuedClient([{ data: { id: COMPANY_ID } }, { data: [] }]),
    ),
    { ok: false, error: "not_found" },
  );

  assert.deepEqual(
    await resolveChatByCompanyGuidAndPhone(
      session(),
      GUID,
      "584241889634",
      queuedClient([
        { data: { id: COMPANY_ID } },
        { data: [{ id: CONTACT_ID }] },
        { data: [] },
      ]),
    ),
    { ok: false, error: "not_found" },
  );
});
