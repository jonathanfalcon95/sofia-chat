import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Row } from "./connection.ts";
import type { SqlDb } from "./db.ts";
import type { SqlFragment } from "./sql.ts";
import {
  applyYCloudEvent,
  DuplicateEvent,
  processYCloudEvent,
  processYCloudWebhook,
  processYCloudWebhookForAccount,
} from "./webhook.ts";

const NOW = new Date("2026-11-06T12:00:00.123Z");
const NOW_ISO = NOW.toISOString();
const INBOX = { id: "inbox-1", company_id: "company-1", phone_number: "+584125550100" };

type Script = Array<[RegExp, Row[] | Error]>;

/** Answers statements by the first regex that matches, and records them. */
function fakeTx(script: Script) {
  const statements: SqlFragment[] = [];
  const tx: SqlDb = {
    __sqlserver: true,
    actor: { kind: "system" },
    async run(statement) {
      statements.push(statement);
      for (const [pattern, answer] of script) {
        if (pattern.test(statement.text)) {
          if (answer instanceof Error) throw answer;
          return answer;
        }
      }
      return [];
    },
  };
  const find = (pattern: RegExp) => statements.filter((s) => pattern.test(s.text));
  return { tx, statements, find };
}

const INBOXES: Script[number] = [/FROM chatbase\.inboxes/, [INBOX]];
const NEW_CONTACT: Script[number] = [/INSERT INTO chatbase\.contacts/, [{ id: "contact-1" }]];
const NEW_CONVERSATION: Script[number] = [/INSERT INTO chatbase\.conversations/, [{ id: "conv-1" }]];

function inbound(msg: Record<string, unknown>) {
  return { whatsappInboundMessage: { id: "m1", from: "+1555", to: "584125550100", ...msg } };
}

function run(tx: SqlDb, eventType: string, payload: unknown) {
  return applyYCloudEvent(tx, "ev1", eventType, payload, { now: NOW });
}

const INBOUND = "whatsapp.inbound_message.received";
const UPDATED = "whatsapp.message.updated";

describe("event record", () => {
  test("the insert comes first, with the injected clock", async () => {
    const { tx, statements } = fakeTx([]);
    const payload = { id: "ev1" };
    assert.deepEqual(await run(tx, "contact.created", payload), { ok: true, ignored: "contact.created" });
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0].params, ["ev1", "contact.created", JSON.stringify(payload), NOW_ISO]);
  });

  for (const number of [2627, 2601]) {
    test(`error ${number} is a duplicate and stops there`, async () => {
      const error = Object.assign(new Error("dup"), { number });
      const { tx, statements } = fakeTx([[/INSERT INTO chatbase\.webhook_events/, error]]);
      await assert.rejects(run(tx, INBOUND, inbound({})), DuplicateEvent);
      assert.equal(statements.length, 1);
    });
  }

  test("other insert errors stay errors", async () => {
    const error = Object.assign(new Error("boom"), { number: 8152 });
    const { tx } = fakeTx([[/INSERT INTO chatbase\.webhook_events/, error]]);
    await assert.rejects(run(tx, INBOUND, inbound({})), { message: "boom" });
  });

  test("a unique violation later on is not a duplicate", async () => {
    const error = Object.assign(new Error("race"), { number: 2627 });
    const { tx } = fakeTx([INBOXES, [/INSERT INTO chatbase\.contacts/, error]]);
    await assert.rejects(run(tx, INBOUND, inbound({})), { message: "race" });
  });
});

describe("inbound", () => {
  test("no message", async () => {
    const { tx } = fakeTx([]);
    assert.deepEqual(await run(tx, INBOUND, {}), { ok: true, skipped: "no_message" });
  });

  test("inbox not found, and malformed content is not read", async () => {
    const { tx } = fakeTx([[/FROM chatbase\.inboxes/, []]]);
    const result = await run(tx, INBOUND, inbound({ type: "contacts", contacts: {}, createTime: "bad" }));
    assert.deepEqual(result, { ok: true, skipped: "inbox_not_found" });
  });

  test("inbox unassigned", async () => {
    const { tx } = fakeTx([[/FROM chatbase\.inboxes/, [{ ...INBOX, company_id: null }]]]);
    assert.deepEqual(await run(tx, INBOUND, inbound({})), { ok: true, skipped: "inbox_unassigned" });
  });

  test("new contact, conversation and message", async () => {
    const { tx, find, statements } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    const payload = inbound({ text: { body: "hola" }, createTime: "2026-01-02T00:00:00Z" });
    assert.deepEqual(await run(tx, INBOUND, payload), { ok: true, conversation_id: "conv-1" });

    const conversation = find(/INSERT INTO chatbase\.conversations/)[0];
    assert.deepEqual(conversation.params, [
      "company-1", "inbox-1", "contact-1", "open",
      "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z",
      "hola", 1, NOW_ISO, NOW_ISO,
    ]);

    const message = find(/INSERT INTO chatbase\.messages/)[0];
    assert.deepEqual(message.params, [
      "conv-1", "company-1", "inbound", "text", "hola", "m1", null, null, "received",
      JSON.stringify(payload.whatsappInboundMessage), null, null, null, null, NOW_ISO,
    ]);

    const order = statements.map((s) => /(INSERT INTO|UPDATE|FROM) chatbase\.(\w+)/.exec(s.text)?.[2]);
    assert.deepEqual(order, ["webhook_events", "inboxes", "contacts", "contacts", "conversations", "conversations", "messages", "messages", "conversation_tags"]);
    assert.deepEqual(find(/INSERT INTO chatbase\.conversation_tags/)[0].params, ["conv-1", NOW_ISO, "company-1", "conv-1"]);
    assert.match(find(/INSERT INTO chatbase\.conversation_tags/)[0].text, /NOT EXISTS[\s\S]*ORDER BY t\.position/);
  });

  test("upserts lock before they write", async () => {
    const { tx, find } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    await run(tx, INBOUND, inbound({}));
    for (const table of ["contacts", "conversations", "messages"]) {
      assert.match(find(new RegExp(`SELECT[\\s\\S]*FROM chatbase\\.${table}`))[0].text, /WITH \(UPDLOCK, HOLDLOCK\)/);
    }
  });

  test("existing rows: closed reopens, unread adds up, metadata merges, updated_at follows the clock", async () => {
    const { tx, find } = fakeTx([
      INBOXES,
      [/SELECT[\s\S]*FROM chatbase\.contacts/, [{ id: "contact-1", name: "+1555", phone_number: "+1555", metadata: { a: 1 } }]],
      [/SELECT[\s\S]*FROM chatbase\.conversations/, [{ id: "conv-1", status: "closed", unread_count: 5 }]],
      [/SELECT[\s\S]*FROM chatbase\.messages/, [{ id: "msg-1", body: "[text]", wamid: "w", reply_to_wamid: null, media_url: "u", media_mime: null, media_filename: null, media_sha256: null, raw_payload: { old: 1 } }]],
    ]);
    const result = await run(tx, INBOUND, inbound({ text: { body: "hola" }, customerProfile: { name: "Ana" }, fromUserId: "u1", status: "delivered" }));
    assert.deepEqual(result, { ok: true, conversation_id: "conv-1" });

    assert.deepEqual(find(/UPDATE chatbase\.contacts/)[0].params, ["Ana", JSON.stringify({ a: 1, ycloud_from_user_id: "u1" }), NOW_ISO, "contact-1"]);
    const conversation = find(/UPDATE chatbase\.conversations/)[0].params;
    assert.equal(conversation[4], 6);
    assert.equal(conversation[5], "open");
    assert.equal(conversation[1], NOW_ISO);
    const message = find(/UPDATE chatbase\.messages/)[0];
    assert.match(message.text, /type = @p9/);
    assert.equal(message.params[0], "delivered");
    assert.equal(message.params[2], "w");
    assert.equal(message.params[4], "u");
    assert.equal(message.params[8], "hola");
    assert.equal(message.params[9], "text");
    assert.equal(message.params[10], "msg-1");
    assert.equal(find(/INSERT INTO chatbase\.messages/).length, 0);
  });

  test("without an injected clock updated_at is SYSUTCDATETIME()", async () => {
    const { tx, find } = fakeTx([
      INBOXES,
      [/SELECT[\s\S]*FROM chatbase\.contacts/, [{ id: "contact-1", name: "x", phone_number: "+1555", metadata: {} }]],
      NEW_CONVERSATION,
    ]);
    await applyYCloudEvent(tx, "ev1", INBOUND, inbound({}));
    assert.match(find(/UPDATE chatbase\.contacts/)[0].text, /updated_at = SYSUTCDATETIME\(\)/);
  });

  test("a NULL message id always inserts", async () => {
    const { tx, find } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    await run(tx, INBOUND, { whatsappInboundMessage: { to: "584125550100" } });
    assert.equal(find(/SELECT[\s\S]*FROM chatbase\.messages/).length, 0);
    assert.equal(find(/INSERT INTO chatbase\.messages/).length, 1);
  });

  test("bad createTime fails only when it is reached", async () => {
    const { tx } = fakeTx([INBOXES, NEW_CONTACT]);
    await assert.rejects(run(tx, INBOUND, inbound({ createTime: "" })), { code: "22007" });
    const skipped = fakeTx([INBOXES]);
    const result = await run(skipped.tx, INBOUND, inbound({ type: "reaction", createTime: "bad" }));
    assert.deepEqual(result, { ok: true, skipped: "reaction_missing_target" });
  });

  const numberChange = inbound({ type: "system", system: { type: "user_changed_number", wa_id: "+1999" } });

  test("number change with a free number", async () => {
    const { tx, find } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    await run(tx, INBOUND, numberChange);
    const update = find(/SET phone_number/)[0];
    assert.deepEqual(update.params, ["+1999", NOW_ISO, "company-1", "+1555"]);
    assert.deepEqual(find(/SELECT TOP \(1\) id FROM chatbase\.contacts/)[0].params, ["company-1", "+1999"]);
  });

  test("number change onto a taken number is left alone", async () => {
    const { tx, find } = fakeTx([
      INBOXES,
      NEW_CONTACT,
      NEW_CONVERSATION,
      [/SELECT TOP \(1\) id FROM chatbase\.contacts/, [{ id: "contact-2" }]],
    ]);
    assert.deepEqual(await run(tx, INBOUND, numberChange), { ok: true, conversation_id: "conv-1" });
    assert.equal(find(/SET phone_number/).length, 0);
  });

  test("number change to the same number finds no conflict with itself", async () => {
    const { tx, find } = fakeTx([
      INBOXES,
      NEW_CONTACT,
      NEW_CONVERSATION,
      [/SELECT TOP \(1\) id FROM chatbase\.contacts/, [{ id: "contact-1" }]],
    ]);
    await run(tx, INBOUND, inbound({ from: "+1999", type: "system", system: { type: "user_changed_number", wa_id: "1999" } }));
    assert.equal(find(/SET phone_number/).length, 1);
  });

  describe("reaction", () => {
    const reaction = inbound({ type: "reaction", reaction: { message_id: "t1", emoji: "👍" } });

    test("missing target", async () => {
      const { tx } = fakeTx([INBOXES]);
      assert.deepEqual(await run(tx, INBOUND, inbound({ type: "reaction" })), { ok: true, skipped: "reaction_missing_target" });
    });

    test("target not found", async () => {
      const { tx } = fakeTx([INBOXES]);
      assert.deepEqual(await run(tx, INBOUND, reaction), { ok: true, skipped: "reaction_target_not_found" });
    });

    test("stores the reaction under UPDLOCK", async () => {
      const old = { emoji: "😀", from: "1555", direction: "inbound" };
      const keep = { emoji: "😀", from: "9", direction: "inbound" };
      const { tx, find } = fakeTx([INBOXES, [/FROM chatbase\.messages/, [{ id: "msg-1", reactions: [old, keep] }]]]);
      assert.deepEqual(await run(tx, INBOUND, reaction), { ok: true, reaction: true, message_id: "msg-1" });
      const select = find(/FROM chatbase\.messages/)[0];
      assert.match(select.text, /WITH \(UPDLOCK\)[\s\S]*ORDER BY created_at DESC/);
      assert.deepEqual(select.params, ["company-1", "t1", "t1"]);
      const update = find(/SET reactions/)[0];
      assert.deepEqual(JSON.parse(update.params[0] as string), [keep, { emoji: "👍", from: "+1555", direction: "inbound" }]);
      assert.equal(find(/chatbase\.contacts/).length, 0);
    });
  });

  describe("revoke", () => {
    test("no target updates nothing and reports null", async () => {
      const { tx, statements } = fakeTx([INBOXES]);
      assert.deepEqual(await run(tx, INBOUND, inbound({ type: "revoke" })), { ok: true, revoked: null });
      assert.equal(statements.length, 2);
    });

    test("updates every match", async () => {
      const { tx, find } = fakeTx([
        INBOXES,
        [/SELECT id, raw_payload FROM chatbase\.messages/, [{ id: "a", raw_payload: { x: 1 } }, { id: "b", raw_payload: null }]],
      ]);
      const payload = inbound({ type: "revoke", revoke: { wamid: "t1" } });
      assert.deepEqual(await run(tx, INBOUND, payload), { ok: true, revoked: "t1" });
      const updates = find(/UPDATE chatbase\.messages/);
      assert.equal(updates.length, 2);
      assert.match(updates[0].text, /media_url = NULL, media_mime = NULL/);
      assert.equal(updates[0].params[0], "Mensaje eliminado");
      const event = { revoked_at: "2026-11-06T12:00:00.123+00:00", revoke_event: payload.whatsappInboundMessage };
      assert.deepEqual(JSON.parse(updates[0].params[1] as string), { x: 1, ...event });
      assert.deepEqual(JSON.parse(updates[1].params[1] as string), event);
      assert.equal(updates[1].params[2], "b");
    });
  });
});

describe("outbound", () => {
  function outbound(msg: Record<string, unknown>) {
    return { whatsappMessage: { id: "m1", from: "584125550100", to: "+1555", ...msg } };
  }

  test("no message", async () => {
    const { tx } = fakeTx([]);
    assert.deepEqual(await run(tx, UPDATED, {}), { ok: true, skipped: "no_message" });
  });

  test("updates every matching row and returns", async () => {
    const stored = { body: null, wamid: null, reply_to_wamid: null, media_url: null, media_mime: null, media_filename: null, media_sha256: null, raw_payload: { a: 1 } };
    const { tx, find, statements } = fakeTx([
      [/SELECT[\s\S]*FROM chatbase\.messages/, [{ id: "a", ...stored }, { id: "b", ...stored, body: "kept" }]],
    ]);
    const result = await run(tx, UPDATED, outbound({ wamid: "w1", status: "sent", text: { body: "hola" } }));
    assert.deepEqual(result, { ok: true, updated: true, wamid: "w1" });
    const select = find(/SELECT[\s\S]*FROM chatbase\.messages/)[0];
    assert.match(select.text, /WITH \(UPDLOCK, HOLDLOCK\)/);
    assert.deepEqual(select.params, ["m1", "w1"]);
    const updates = find(/UPDATE chatbase\.messages/);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].params[8], "hola");
    assert.equal(updates[1].params[8], "kept");
    assert.equal(statements.length, 4);
  });

  test("the result reports a null wamid", async () => {
    const stored = { id: "a", body: "x", raw_payload: null };
    const { tx } = fakeTx([[/SELECT[\s\S]*FROM chatbase\.messages/, [stored]]]);
    assert.deepEqual(await run(tx, UPDATED, outbound({})), { ok: true, updated: true, wamid: null });
  });

  test("inbox not found and unassigned", async () => {
    const missing = fakeTx([[/FROM chatbase\.inboxes/, []]]);
    assert.deepEqual(await run(missing.tx, UPDATED, outbound({})), { ok: true, skipped: "inbox_not_found" });
    const unassigned = fakeTx([[/FROM chatbase\.inboxes/, [{ ...INBOX, company_id: null }]]]);
    assert.deepEqual(await run(unassigned.tx, UPDATED, outbound({})), { ok: true, skipped: "inbox_unassigned" });
  });

  test("malformed content fails even without an inbox", async () => {
    const { tx } = fakeTx([[/FROM chatbase\.inboxes/, []]]);
    await assert.rejects(run(tx, UPDATED, outbound({ type: "order", order: { product_items: {} } })), { name: "PgRaisedError" });
  });

  test("inserts with created_at from sendTime", async () => {
    const { tx, find } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    const sendTime = "2026-01-02T00:00:00.000Z";
    const payload = outbound({ sendTime, createTime: "bad", text: { body: "hola" } });
    assert.deepEqual(await run(tx, UPDATED, payload), { ok: true, conversation_id: "conv-1" });
    assert.deepEqual(find(/INSERT INTO chatbase\.contacts/)[0].params, ["company-1", "+1555", NOW_ISO, NOW_ISO]);
    assert.deepEqual(find(/INSERT INTO chatbase\.conversations/)[0].params, ["company-1", "inbox-1", "contact-1", sendTime, "hola", NOW_ISO, NOW_ISO]);
    const message = find(/INSERT INTO chatbase\.messages/)[0].params;
    assert.equal(message[2], "outbound");
    assert.equal(message[14], sendTime);
    assert.equal(message.length, 15);
  });

  test("with no times created_at is now", async () => {
    const { tx, find } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    await run(tx, UPDATED, outbound({}));
    assert.equal(find(/INSERT INTO chatbase\.messages/)[0].params[14], NOW_ISO);
  });

  test("a bad sendTime fails the event", async () => {
    const { tx, find } = fakeTx([INBOXES, NEW_CONTACT, NEW_CONVERSATION]);
    await assert.rejects(run(tx, UPDATED, outbound({ sendTime: "bad" })), { code: "22007" });
    assert.equal(find(/INSERT INTO chatbase\.messages/).length, 0);
  });

  test("existing conversation keeps the newest time and preview", async () => {
    const { tx, find } = fakeTx([
      INBOXES,
      [/SELECT[\s\S]*FROM chatbase\.contacts/, [{ id: "contact-1" }]],
      [/SELECT[\s\S]*FROM chatbase\.conversations/, [{ id: "conv-1", last_message_at: "2030-01-01T00:00:00.000Z", last_message_preview: "newest" }]],
    ]);
    await run(tx, UPDATED, outbound({ sendTime: "2026-01-02T00:00:00Z", text: { body: "older" } }));
    assert.deepEqual(find(/UPDATE chatbase\.conversations/)[0].params, ["2030-01-01T00:00:00.000Z", "newest", NOW_ISO, "conv-1"]);
    assert.deepEqual(find(/UPDATE chatbase\.contacts/)[0].params, [NOW_ISO, "contact-1"]);
  });

  describe("reaction", () => {
    const reaction = outbound({ type: "reaction", reaction: { message_id: "t1", emoji: "👍" } });

    test("skips", async () => {
      const missing = fakeTx([[/FROM chatbase\.inboxes/, []]]);
      assert.deepEqual(await run(missing.tx, UPDATED, reaction), { ok: true, skipped: "reaction_inbox_not_found" });
      const unassigned = fakeTx([[/FROM chatbase\.inboxes/, [{ ...INBOX, company_id: null }]]]);
      assert.deepEqual(await run(unassigned.tx, UPDATED, reaction), { ok: true, skipped: "inbox_unassigned" });
      const noTarget = fakeTx([INBOXES]);
      assert.deepEqual(await run(noTarget.tx, UPDATED, outbound({ type: "reaction" })), { ok: true, skipped: "reaction_missing_target" });
      const notFound = fakeTx([INBOXES]);
      assert.deepEqual(await run(notFound.tx, UPDATED, reaction), { ok: true, skipped: "reaction_target_not_found" });
    });

    test("stores it as outbound", async () => {
      const { tx, find } = fakeTx([INBOXES, [/FROM chatbase\.messages/, [{ id: "msg-1", reactions: [] }]]]);
      assert.deepEqual(await run(tx, UPDATED, reaction), { ok: true, reaction: true, direction: "outbound", message_id: "msg-1" });
      assert.deepEqual(JSON.parse(find(/SET reactions/)[0].params[0] as string), [{ emoji: "👍", from: "584125550100", direction: "outbound" }]);
    });
  });
});

describe("entry points that fail before touching the database", () => {
  const { tx: db, statements } = fakeTx([]);

  test("invalid secret", async () => {
    const saved = process.env.YCLOUD_WEBHOOK_SECRET;
    process.env.YCLOUD_WEBHOOK_SECRET = " expected ";
    try {
      const wrong = await processYCloudWebhook(db, "wrong", "ev1", INBOUND, {});
      assert.equal(wrong.data, null);
      assert.equal(wrong.error?.message, "invalid webhook secret");
      delete process.env.YCLOUD_WEBHOOK_SECRET;
      const unset = await processYCloudWebhook(db, "", "ev1", INBOUND, {});
      assert.equal(unset.error?.message, "invalid webhook secret");
    } finally {
      if (saved === undefined) delete process.env.YCLOUD_WEBHOOK_SECRET;
      else process.env.YCLOUD_WEBHOOK_SECRET = saved;
    }
    assert.equal(statements.length, 0);
  });

  test("malformed account id", async () => {
    const result = await processYCloudWebhookForAccount(db, "not-a-uuid", "ev1", INBOUND, {});
    assert.equal(result.data, null);
    assert.equal(result.error?.message, "unknown ycloud account");
  });

  test("the wrappers also take the repository's argument object", async () => {
    const args = { eventId: "ev1", eventType: INBOUND, payload: {} };
    const account = await processYCloudWebhookForAccount(db, { accountId: "not-a-uuid", ...args });
    assert.equal(account.error?.message, "unknown ycloud account");
    const secret = await processYCloudWebhook(db, { secret: "wrong", ...args });
    assert.equal(secret.error?.message, "invalid webhook secret");
  });

  test("a payload jsonb would reject rejects, and comes back as an error from the wrappers", async () => {
    await assert.rejects(processYCloudEvent(db, "ev1", INBOUND, { a: "\u0000" }), { code: "22P05" });
    const saved = process.env.YCLOUD_WEBHOOK_SECRET;
    process.env.YCLOUD_WEBHOOK_SECRET = "s";
    try {
      const result = await processYCloudWebhook(db, "s", "ev1", INBOUND, { a: "\u0000" });
      assert.equal(result.data, null);
      assert.equal(result.error?.message, "unsupported Unicode escape sequence");
    } finally {
      if (saved === undefined) delete process.env.YCLOUD_WEBHOOK_SECRET;
      else process.env.YCLOUD_WEBHOOK_SECRET = saved;
    }
  });
});
