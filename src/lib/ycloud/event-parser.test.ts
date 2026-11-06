import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyReaction,
  applySendTime,
  arrow,
  arrowText,
  assertJsonbStorable,
  digitsOnly,
  inboundTimestamp,
  isPlaceholderBody,
  jsonbConcat,
  jsonbText,
  matchInbox,
  mergeInboundContact,
  mergeInboundConversation,
  mergeInboundMessage,
  mergeOutboundConversation,
  mergeOutboundMessage,
  newInboundConversation,
  outboundTimestamp,
  parseTimestamptz,
  pgJsonTimestamp,
  pgLeft,
  pgTrim,
  planInboundContact,
  planInboundMessage,
  planOutboundMessage,
  remapEventType,
  revokedRawPayload,
  routeEvent,
  type Envelope,
  type MessageContent,
  type StoredMessage,
} from "./event-parser.ts";

const NOW = new Date("2026-11-06T12:00:00.123Z");

function inboundEnvelope(msg: unknown): Envelope {
  const route = routeEvent("whatsapp.inbound_message.received", { whatsappInboundMessage: msg });
  assert.equal(route.route, "inbound");
  return (route as { envelope: Envelope }).envelope;
}

function outboundEnvelope(msg: unknown): Envelope {
  const route = routeEvent("whatsapp.message.updated", { whatsappMessage: msg });
  assert.equal(route.route, "outbound");
  return (route as { envelope: Envelope }).envelope;
}

function inboundContent(msg: Record<string, unknown>) {
  const plan = planInboundMessage(inboundEnvelope({ from: "1", to: "2", ...msg }));
  assert.equal(plan.kind, "message");
  return plan as Extract<typeof plan, { kind: "message" }>;
}

function inboundBody(msg: Record<string, unknown>) {
  return inboundContent(msg).content.body;
}

function outboundContent(msg: Record<string, unknown>): MessageContent {
  const plan = planOutboundMessage(outboundEnvelope(msg));
  assert.equal(plan.kind, "message");
  return (plan as { content: MessageContent }).content;
}

const STORED: StoredMessage = {
  body: "old",
  wamid: "wamid.old",
  reply_to_wamid: "wamid.reply",
  media_url: "https://old",
  media_mime: "old/mime",
  media_filename: "old.bin",
  media_sha256: "oldsha",
  raw_payload: { kept: 1 },
};

const NO_MEDIA = { mediaUrl: null, mediaMime: null, mediaFilename: null, mediaSha256: null };

describe("jsonb operators", () => {
  test("-> tells SQL NULL from jsonb null", () => {
    assert.equal(arrow({}, "a"), undefined);
    assert.equal(arrow({ a: null }, "a"), null);
    assert.equal(arrow([1], "a"), undefined);
    assert.equal(arrow("text", "a"), undefined);
    assert.equal(arrow(null, "a"), undefined);
    assert.equal(arrow({}, "constructor"), undefined);
  });

  test("->> gives null on missing and null, and text on everything else", () => {
    assert.equal(arrowText({}, "a"), null);
    assert.equal(arrowText({ a: null }, "a"), null);
    assert.equal(arrowText({ a: "x" }, "a"), "x");
    assert.equal(arrowText({ a: 10.5 }, "a"), "10.5");
    assert.equal(arrowText({ a: true }, "a"), "true");
    assert.equal(arrowText({ a: false }, "a"), "false");
    assert.equal(arrowText({ a: 0 }, "a"), "0");
  });

  test("->> writes nested values the way jsonb prints them", () => {
    assert.equal(arrowText({ a: { bb: [1, "x", null], c: true } }, "a"), '{"c": true, "bb": [1, "x", null]}');
    assert.equal(arrowText({ a: [] }, "a"), "[]");
    assert.equal(jsonbText({}), "{}");
    assert.equal(jsonbText({ b: 1, a: 2 }), '{"a": 2, "b": 1}');
    assert.equal(jsonbText({ é: 1, z: 2, ab: 3 }), '{"z": 2, "ab": 3, "é": 1}');
    assert.equal(jsonbText("line\n\"q\""), '"line\\n\\"q\\""');
  });

  test("numbers never print with exponents", () => {
    assert.equal(jsonbText(1e21), "1000000000000000000000");
    assert.equal(jsonbText(1.5e21), "1500000000000000000000");
    assert.equal(jsonbText(1e-7), "0.0000001");
    assert.equal(jsonbText(-1.5e-7), "-0.00000015");
    assert.equal(jsonbText(-0), "0");
  });

  test("|| is a shallow merge with the right side winning", () => {
    assert.deepEqual(jsonbConcat({ a: { x: 1 }, b: 1 }, { a: { y: 2 } }), { a: { y: 2 }, b: 1 });
  });

  test("|| concatenates arrays and wraps anything else", () => {
    assert.deepEqual(jsonbConcat([1], [2]), [1, 2]);
    assert.deepEqual(jsonbConcat([1], { a: 1 }), [1, { a: 1 }]);
    assert.deepEqual(jsonbConcat({ a: 1 }, [1]), [{ a: 1 }, 1]);
    assert.deepEqual(jsonbConcat(1, 2), [1, 2]);
    assert.deepEqual(jsonbConcat(null, { a: 1 }), [null, { a: 1 }]);
    assert.deepEqual(jsonbConcat({ a: 1 }, "s"), [{ a: 1 }, "s"]);
  });

  test("what the jsonb cast rejects raises", () => {
    assert.doesNotThrow(() => assertJsonbStorable({ a: ["😀", 1, null, { b: true }] }));
    assert.throws(() => assertJsonbStorable({ a: "x\u0000y" }), { code: "22P05" });
    assert.throws(() => assertJsonbStorable({ a: ["\ud83d"] }), { code: "22P02" });
    assert.throws(() => assertJsonbStorable({ "k\u0000": 1 }), { code: "22P05" });
  });
});

describe("text functions", () => {
  test("trim strips spaces only", () => {
    assert.equal(pgTrim("  a b  "), "a b");
    assert.equal(pgTrim("\t a \n"), "\t a \n");
    assert.equal(pgTrim(" a "), " a ");
    assert.equal(pgTrim(null), null);
  });

  test("left counts code points", () => {
    const emoji = "😀".repeat(201);
    assert.equal(pgLeft(emoji, 200), "😀".repeat(200));
    assert.equal(pgLeft(emoji, 200).length, 400);
    assert.equal(pgLeft("abc", 200), "abc");
  });

  test("digits", () => {
    assert.equal(digitsOnly("+58 (412) 555-0100"), "584125550100");
    assert.equal(digitsOnly("٣"), "");
  });

  test("placeholder regex", () => {
    assert.equal(isPlaceholderBody("[image]"), true);
    assert.equal(isPlaceholderBody("[a_b]"), true);
    assert.equal(isPlaceholderBody("[Image]"), false);
    assert.equal(isPlaceholderBody("[]"), false);
    assert.equal(isPlaceholderBody("[a1]"), false);
    assert.equal(isPlaceholderBody("[image]\n"), false);
    assert.equal(isPlaceholderBody("x\n[image]"), false);
  });
});

describe("timestamps", () => {
  const utc = (text: string) => parseTimestamptz(text).toISOString();

  test("accepts the shapes Postgres accepts", () => {
    assert.equal(utc("2026-01-02T03:04:05.678Z"), "2026-01-02T03:04:05.678Z");
    assert.equal(utc("2026-01-02T03:04:05+08:00"), "2026-01-01T19:04:05.000Z");
    assert.equal(utc("2026-01-02 03:04:05-0430"), "2026-01-02T07:34:05.000Z");
    assert.equal(utc("2026-01-02T03:04:05+00"), "2026-01-02T03:04:05.000Z");
    assert.equal(utc("2026-01-02 03:04"), "2026-01-02T03:04:00.000Z");
    assert.equal(utc("2026-01-02"), "2026-01-02T00:00:00.000Z");
    assert.equal(utc("  2026-01-02T03:04:05 UTC "), "2026-01-02T03:04:05.000Z");
    assert.equal(utc("2026-01-02T24:00:00Z"), "2026-01-03T00:00:00.000Z");
    assert.equal(utc("2024-02-29T00:00:00Z"), "2024-02-29T00:00:00.000Z");
  });

  test("rounds sub-millisecond digits like datetime2(3)", () => {
    assert.equal(utc("2026-01-02T03:04:05.123456Z"), "2026-01-02T03:04:05.123Z");
    assert.equal(utc("2026-01-02T03:04:05.1235Z"), "2026-01-02T03:04:05.124Z");
    assert.equal(utc("2026-01-02T03:04:05.9999Z"), "2026-01-02T03:04:06.000Z");
  });

  test("raises where new Date would not", () => {
    for (const bad of ["", " ", "nope", "1700000000", "2026-13-01T00:00:00Z", "2025-02-29", "2026-01-02T25:00:00Z", "2026-01-02T24:00:01Z", "2026-01-02T00:60:00Z", "2026-01-02T00:00:00+16:00", "0000-01-01"]) {
      assert.throws(() => parseTimestamptz(bad), { name: "PgRaisedError" }, bad);
    }
  });

  test("inbound createTime: null falls back to now, empty raises", () => {
    assert.equal(inboundTimestamp({}, NOW), NOW);
    assert.equal(inboundTimestamp({ createTime: null }, NOW), NOW);
    assert.equal(inboundTimestamp({ createTime: "2026-01-02T00:00:00Z" }, NOW).toISOString(), "2026-01-02T00:00:00.000Z");
    assert.throws(() => inboundTimestamp({ createTime: "" }, NOW), { code: "22007" });
    assert.throws(() => inboundTimestamp({ createTime: "bad" }, NOW), { code: "22007" });
    assert.throws(() => inboundTimestamp({ createTime: 1700000000 }, NOW), { code: "22007" });
  });

  test("outbound: empty is guarded, bad raises, createTime is read only without sendTime", () => {
    const send = "2026-01-02T00:00:00.000Z";
    const create = "2026-01-03T00:00:00.000Z";
    assert.equal(outboundTimestamp({}, NOW), NOW);
    assert.equal(outboundTimestamp({ sendTime: "", createTime: "" }, NOW), NOW);
    assert.equal(outboundTimestamp({ sendTime: send, createTime: create }, NOW).toISOString(), send);
    assert.equal(outboundTimestamp({ sendTime: "", createTime: create }, NOW).toISOString(), create);
    assert.equal(outboundTimestamp({ sendTime: send, createTime: "bad" }, NOW).toISOString(), send);
    assert.throws(() => outboundTimestamp({ sendTime: "bad", createTime: create }, NOW), { code: "22007" });
    assert.throws(() => outboundTimestamp({ createTime: "bad" }, NOW), { code: "22007" });
  });

  test("messages_apply_send_time swallows bad values", () => {
    const iso = "2026-01-02T00:00:00.000Z";
    assert.equal(applySendTime(undefined), null);
    assert.equal(applySendTime({}), null);
    assert.equal(applySendTime(null), null);
    assert.equal(applySendTime({ sendTime: iso })?.toISOString(), iso);
    assert.equal(applySendTime({ sendTime: "bad", createTime: iso })?.toISOString(), iso);
    assert.equal(applySendTime({ sendTime: "", createTime: iso })?.toISOString(), iso);
    assert.equal(applySendTime({ sendTime: "bad", createTime: "bad" }), null);
  });

  test("timestamptz inside jsonb", () => {
    assert.equal(pgJsonTimestamp(new Date("2026-01-02T03:04:05.120Z")), "2026-01-02T03:04:05.12+00:00");
    assert.equal(pgJsonTimestamp(new Date("2026-01-02T03:04:05.123Z")), "2026-01-02T03:04:05.123+00:00");
    assert.equal(pgJsonTimestamp(new Date("2026-01-02T03:04:05.000Z")), "2026-01-02T03:04:05+00:00");
  });
});

describe("routing", () => {
  test("wrappers remap Business App echoes only", () => {
    assert.equal(remapEventType("whatsapp.smb.message.echoes"), "whatsapp.message.updated");
    assert.equal(remapEventType("whatsapp.smb.message.created"), "whatsapp.message.updated");
    assert.equal(remapEventType("whatsapp.inbound.message"), "whatsapp.inbound.message");
    assert.equal(remapEventType("other"), "other");
  });

  test("every handled type routes, the rest are ignored", () => {
    const msg = { whatsappInboundMessage: { id: "a" }, whatsappMessage: { id: "b" } };
    for (const type of ["whatsapp.inbound_message.received", "whatsapp.inbound.message"]) {
      const route = routeEvent(type, msg);
      assert.equal(route.route, "inbound");
      assert.equal((route as { envelope: Envelope }).envelope.msgId, "a");
    }
    for (const type of ["whatsapp.message.updated", "whatsapp.smb.message.echoes", "whatsapp.smb.message.created"]) {
      const route = routeEvent(type, msg);
      assert.equal(route.route, "outbound");
      assert.equal((route as { envelope: Envelope }).envelope.msgId, "b");
    }
    assert.equal(routeEvent("contact.created", msg).route, "ignored");
  });

  test("inbound falls back to whatsappMessage, outbound does not read the inbound key", () => {
    const route = routeEvent("whatsapp.inbound.message", { whatsappMessage: { id: "b" } });
    assert.equal((route as { envelope: Envelope }).envelope.msgId, "b");
    assert.equal(routeEvent("whatsapp.inbound.message", {}).route, "no_message");
    assert.equal(routeEvent("whatsapp.message.updated", { whatsappInboundMessage: {} }).route, "no_message");
  });

  test("a jsonb null is a message with no fields, not a missing one", () => {
    const route = routeEvent("whatsapp.inbound.message", { whatsappInboundMessage: null, whatsappMessage: { id: "b" } });
    assert.equal(route.route, "inbound");
    const envelope = (route as { envelope: Envelope }).envelope;
    assert.equal(envelope.msg, null);
    assert.equal(envelope.msgId, null);
    assert.equal(envelope.from, "");
    assert.equal(routeEvent("whatsapp.message.updated", { whatsappMessage: null }).route, "outbound");
  });

  test("envelope defaults", () => {
    const inbound = inboundEnvelope({});
    assert.deepEqual(inbound, { msg: {}, from: "", to: "", msgId: null, wamid: null, replyTo: null, msgType: "text", status: "received" });
    assert.equal(outboundEnvelope({}).status, "updated");
  });

  test("id falls back to wamid, and wamid is taken from an id that looks like one", () => {
    assert.equal(inboundEnvelope({ wamid: "x" }).msgId, "x");
    assert.equal(inboundEnvelope({ id: "", wamid: "x" }).msgId, "");
    assert.equal(inboundEnvelope({ id: "wamid.1" }).wamid, "wamid.1");
    assert.equal(inboundEnvelope({ id: "abc" }).wamid, null);
    assert.equal(inboundEnvelope({ id: "WAMID.1" }).wamid, null);
    assert.equal(inboundEnvelope({ id: "wamid.1", wamid: "" }).wamid, "wamid.1");
    assert.equal(inboundEnvelope({ id: "abc", wamid: "w" }).wamid, "w");
    assert.equal(inboundEnvelope({ id: 123 }).msgId, "123");
  });

  test("reply target order, skipping empties", () => {
    assert.equal(inboundEnvelope({ context: { message_id: "a", id: "b", wamid: "c" } }).replyTo, "a");
    assert.equal(inboundEnvelope({ context: { message_id: "", id: "b", wamid: "c" } }).replyTo, "b");
    assert.equal(inboundEnvelope({ context: { id: "", wamid: "c" } }).replyTo, "c");
    assert.equal(inboundEnvelope({ context: { id: "" } }).replyTo, null);
    assert.equal(inboundEnvelope({ context: "x" }).replyTo, null);
  });
});

describe("inbox matching", () => {
  const inboxes = [{ phone_number: "+58 412-555-0100", id: "a" }, { phone_number: "15550001111", id: "b" }];

  test("matches by digits whatever the format", () => {
    assert.equal(matchInbox(inboxes, "584125550100")?.id, "a");
    assert.equal(matchInbox(inboxes, "+15550001111")?.id, "b");
    assert.equal(matchInbox(inboxes, "15550001111")?.id, "b");
    assert.equal(matchInbox(inboxes, "999"), null);
  });

  test("the first of several matches wins", () => {
    assert.equal(matchInbox([{ phone_number: "+123", id: "x" }, { phone_number: "123", id: "y" }], "123")?.id, "x");
  });

  test("an empty phone matches only a phone with no digits", () => {
    assert.equal(matchInbox(inboxes, ""), null);
    assert.equal(matchInbox([{ phone_number: "n/a", id: "z" }], "")?.id, "z");
  });
});

describe("content, on both paths", () => {
  const bodies: Array<[string, Record<string, unknown>, string]> = [
    ["interactive with body and url", { type: "interactive", interactive: { body: { text: " Hola " }, action: { parameters: { url: "https://x", display_text: " Ver " } } } }, "Hola\nVer: https://x"],
    ["interactive with default link text", { type: "interactive", interactive: { body: { text: "Hola" }, action: { parameters: { url: "https://x", display_text: "  " } } } }, "Hola\nAbrir enlace: https://x"],
    ["interactive with url only", { type: "interactive", interactive: { action: { parameters: { url: "https://x" } } } }, "Abrir enlace: https://x"],
    ["interactive with body only", { type: "interactive", interactive: { body: { text: "Hola" }, action: { parameters: { url: "" } } } }, "Hola"],
    ["empty interactive", { type: "interactive", interactive: { body: { text: "   " } } }, "Mensaje interactivo"],
    ["interactive missing", { type: "interactive" }, "Mensaje interactivo"],
    ["contact with phones", { type: "contacts", contacts: [{ name: { formatted_name: " Ana " }, phones: [{ phone: "+1", type: "CELL" }, { wa_id: "2" }, { phone: "", wa_id: "" }, { phone: "3", type: "" }] }] }, "Ana\nCELL: +1\n2\n3"],
    ["contact from name parts", { type: "contacts", contacts: [{ name: { first_name: "Ana", middle_name: "", last_name: "Paz" } }] }, "Ana Paz"],
    ["contact with no name", { type: "contacts", contacts: [{ name: {} }] }, "Contacto"],
    ["two contacts", { type: "contacts", contacts: [{ name: { formatted_name: "A" }, phones: [{ phone: "1" }] }, { name: { formatted_name: "B" } }] }, "A\n1\nB"],
    ["no contacts key", { type: "contacts" }, "Contacto compartido"],
    ["empty contacts", { type: "contacts", contacts: [] }, "Contacto compartido"],
    ["contact that is not an object", { type: "contacts", contacts: ["x"] }, "Contacto"],
    ["location with name and address", { type: "location", location: { name: " Casa ", address: " Calle 1 " } }, "📍 Casa\nCalle 1"],
    ["location with name", { type: "location", location: { name: "Casa", address: "  " } }, "📍 Casa"],
    ["location with address", { type: "location", location: { address: "Calle 1" } }, "📍 Calle 1"],
    ["location with coordinates", { type: "location", location: { latitude: 10.48, longitude: -66.9 } }, "📍 Ubicación: 10.48, -66.9"],
    ["location with text coordinates keeps zeros", { type: "location", location: { latitude: "10.4800", longitude: "-66.9000" } }, "📍 Ubicación: 10.4800, -66.9000"],
    ["location at zero", { type: "location", location: { latitude: 0, longitude: 0 } }, "📍 Ubicación: 0, 0"],
    ["location with one coordinate", { type: "location", location: { latitude: 10 } }, "📍 Ubicación compartida"],
    ["location missing", { type: "location" }, "📍 Ubicación compartida"],
    ["order with text", { type: "order", order: { text: " Quiero ", product_items: [{}] } }, "Quiero"],
    ["order with one item", { type: "order", order: { product_items: [{}] } }, "🛒 Pedido de catálogo (1 artículo)"],
    ["order with two items", { type: "order", order: { text: "  ", product_items: [{}, {}] } }, "🛒 Pedido de catálogo (2 artículos)"],
    ["order with no items", { type: "order", order: { product_items: [] } }, "🛒 Pedido de catálogo"],
    ["order missing", { type: "order" }, "🛒 Pedido de catálogo"],
    ["text", { type: "text", text: { body: "  hola  " } }, "  hola  "],
    ["empty text stays empty", { type: "text", text: { body: "" } }, ""],
    ["caption fallback", { type: "text", caption: "c" }, "c"],
    ["type defaults to text", { text: { body: "x" } }, "x"],
    ["placeholder for unknown types", { type: "button" }, "[button]"],
    ["placeholder for no text", {}, "[text]"],
    ["numeric text", { type: "text", text: { body: 12 } }, "12"],
  ];

  for (const [name, msg, expected] of bodies) {
    test(`${name}: inbound`, () => assert.equal(inboundBody(msg), expected));
    test(`${name}: outbound`, () => assert.equal(outboundContent(msg).body, expected));
  }

  const failing: Array<[string, Record<string, unknown>, string]> = [
    ["contacts as object", { type: "contacts", contacts: {} }, "cannot extract elements from an object"],
    ["contacts as jsonb null", { type: "contacts", contacts: null }, "cannot extract elements from a scalar"],
    ["phones as string", { type: "contacts", contacts: [{ phones: "x" }] }, "cannot extract elements from a scalar"],
    ["product_items as object", { type: "order", order: { product_items: {} } }, "cannot get array length of a non-array"],
    ["product_items as jsonb null", { type: "order", order: { text: "has text", product_items: null } }, "cannot get array length of a scalar"],
    ["product_items as number", { type: "order", order: { product_items: 3 } }, "cannot get array length of a scalar"],
  ];

  for (const [name, msg, message] of failing) {
    test(`${name} raises on both paths`, () => {
      assert.throws(() => inboundBody(msg), { name: "PgRaisedError", message });
      assert.throws(() => outboundContent(msg), { name: "PgRaisedError", message });
    });
  }

  test("order that is not an object does not raise", () => {
    assert.equal(inboundBody({ type: "order", order: "x" }), "🛒 Pedido de catálogo");
  });

  const media: Array<[string, string]> = [
    ["image", "Imagen"],
    ["audio", "Nota de voz"],
    ["video", "Video"],
    ["sticker", "Sticker"],
    ["document", "Documento"],
  ];

  for (const [type, label] of media) {
    test(`${type} media`, () => {
      const full = { link: "https://m", mime_type: "a/b", filename: "f.bin", sha256: "s", caption: "cap" };
      for (const format of [(m: Record<string, unknown>) => inboundContent(m).content, outboundContent]) {
        assert.deepEqual(format({ type, [type]: full }), { type, body: "cap", mediaUrl: "https://m", mediaMime: "a/b", mediaFilename: "f.bin", mediaSha256: "s" });
        assert.equal(format({ type, [type]: { ...full, caption: "" } }).body, "f.bin");
        assert.equal(format({ type, [type]: { link: "https://m" } }).body, label);
        assert.deepEqual(format({ type }), { type, body: label, ...NO_MEDIA });
        assert.deepEqual(format({ type, [type]: "not an object" }), { type, body: label, ...NO_MEDIA });
        assert.deepEqual(format({ type, [type]: { link: "", mime_type: "", filename: "", sha256: "" } }), { type, body: label, ...NO_MEDIA });
        assert.equal(format({ type, [type]: { mimeType: "c/d" } }).mediaMime, "c/d");
        assert.equal(format({ type, [type]: { mime_type: "", mimeType: "c/d" } }).mediaMime, "c/d");
        assert.equal(format({ type, [type]: { mime_type: "a/b", mimeType: "c/d" } }).mediaMime, "a/b");
      }
    });
  }

  test("a key named like a prototype member is not a media type", () => {
    assert.equal(inboundBody({ type: "constructor" }), "[constructor]");
  });

  test("the preview cuts at 200 code points", () => {
    const body = "😀".repeat(250);
    const plan = inboundContent({ type: "text", text: { body } });
    assert.equal(plan.content.body, body);
    assert.equal(plan.preview, "😀".repeat(200));
    const outbound = planOutboundMessage(outboundEnvelope({ type: "text", text: { body } }));
    assert.equal((outbound as { preview: string }).preview, "😀".repeat(200));
  });
});

describe("inbound-only types", () => {
  test("system: number change", () => {
    const plan = inboundContent({ type: "system", system: { type: "user_changed_number", wa_id: "+5841" } });
    assert.equal(plan.content.body, "El contacto cambió de número a +5841");
    assert.equal(plan.newPhone, "+5841");
    assert.equal(inboundContent({ type: "system", system: { type: "user_changed_number", wa_id: "5841" } }).newPhone, "+5841");
    assert.equal(inboundContent({ type: "system", system: { type: "user_changed_number", wa_id: "++5841" } }).newPhone, "++5841");
  });

  test("system: other", () => {
    const body = inboundContent({ type: "system", system: { type: "x", wa_id: "1", body: "Texto" } });
    assert.equal(body.content.body, "Texto");
    assert.equal(body.newPhone, null);
    const noWaId = inboundContent({ type: "system", system: { type: "user_changed_number", wa_id: "", body: "T" } });
    assert.equal(noWaId.content.body, "T");
    assert.equal(noWaId.newPhone, null);
    assert.equal(inboundBody({ type: "system", system: { body: "" } }), "Mensaje del sistema de WhatsApp");
    assert.equal(inboundBody({ type: "system" }), "Mensaje del sistema de WhatsApp");
  });

  test("unsupported", () => {
    assert.equal(inboundBody({ type: "unsupported" }), "WhatsApp no compartió este mensaje (tipo no disponible para negocios).");
  });

  test("outbound treats system, unsupported, edit and revoke as unknown types", () => {
    assert.equal(outboundContent({ type: "system", system: { body: "x" } }).body, "[system]");
    assert.equal(outboundContent({ type: "unsupported" }).body, "[unsupported]");
    assert.equal(outboundContent({ type: "edit", edit: { message: { text: { body: "x" } } } }).body, "[edit]");
    assert.equal(outboundContent({ type: "revoke" }).body, "[revoke]");
  });

  test("edit with a message formats that message and keeps the original as raw", () => {
    const plan = inboundContent({ type: "edit", edit: { message: { type: "text", text: { body: "nuevo" } } } });
    assert.equal(plan.content.type, "text");
    assert.equal(plan.content.body, "nuevo");
    const image = inboundContent({ type: "edit", edit: { message: { type: "image", image: { caption: "c", link: "l" } } } });
    assert.deepEqual(image.content, { type: "image", body: "c", mediaUrl: "l", mediaMime: null, mediaFilename: null, mediaSha256: null });
    assert.equal(inboundContent({ type: "edit", edit: { message: { text: { body: "t" } } } }).content.type, "text");
  });

  test("edit of a system message can change the number", () => {
    const plan = inboundContent({ type: "edit", edit: { message: { type: "system", system: { type: "user_changed_number", wa_id: "9" } } } });
    assert.equal(plan.newPhone, "+9");
  });

  test("edit without a message object", () => {
    for (const edit of [undefined, {}, { message: "x" }, { message: null }, { message: [1] }]) {
      const plan = inboundContent({ type: "edit", edit, text: { body: "ignored" } });
      assert.deepEqual(plan.content, { type: "text", body: "Mensaje editado", ...NO_MEDIA });
    }
  });

  test("an edit holding a reaction, revoke or edit is not acted on", () => {
    assert.equal(inboundBody({ type: "edit", edit: { message: { type: "reaction" } } }), "[reaction]");
    assert.equal(inboundBody({ type: "edit", edit: { message: { type: "revoke" } } }), "[revoke]");
    assert.equal(inboundBody({ type: "edit", edit: { message: { type: "edit", edit: { message: { type: "text" } } } } }), "[edit]");
  });

  test("revoke target order", () => {
    const target = (msg: Record<string, unknown>) => planInboundMessage(inboundEnvelope({ type: "revoke", ...msg }));
    assert.deepEqual(target({ revoke: { message_id: "a", wamid: "b" } }), { kind: "revoke", target: "a" });
    assert.deepEqual(target({ revoke: { message_id: "", wamid: "b" } }), { kind: "revoke", target: "b" });
    assert.deepEqual(target({ revoke: {}, context: { id: "c" } }), { kind: "revoke", target: "c" });
    assert.deepEqual(target({}), { kind: "revoke", target: null });
  });

  test("reaction plan on both paths", () => {
    const msg = { type: "reaction", reaction: { message_id: "a", wamid: "b", emoji: "👍" } };
    assert.deepEqual(planInboundMessage(inboundEnvelope(msg)), { kind: "reaction", target: "a", emoji: "👍" });
    assert.deepEqual(planOutboundMessage(outboundEnvelope(msg)), { kind: "reaction", target: "a", emoji: "👍" });
    assert.deepEqual(planInboundMessage(inboundEnvelope({ type: "reaction", reaction: { wamid: "b" } })), { kind: "reaction", target: "b", emoji: "" });
    assert.deepEqual(planInboundMessage(inboundEnvelope({ type: "reaction", context: { id: "c" } })), { kind: "reaction", target: "c", emoji: "" });
    assert.deepEqual(planOutboundMessage(outboundEnvelope({ type: "reaction" })), { kind: "reaction", target: null, emoji: "" });
  });
});

describe("reactions", () => {
  const inbound = (emoji: string, from = "+58412") => ({ emoji, from, direction: "inbound" as const });

  test("adds to an empty list, and treats non-arrays as empty", () => {
    const added = [{ emoji: "👍", from: "+58412", direction: "inbound" }];
    assert.deepEqual(applyReaction([], inbound("👍")), added);
    assert.deepEqual(applyReaction(undefined, inbound("👍")), added);
    assert.deepEqual(applyReaction(null, inbound("👍")), added);
    assert.deepEqual(applyReaction({ a: 1 }, inbound("👍")), added);
  });

  test("replaces the sender's own, matching exactly or by digits", () => {
    const old = { emoji: "😀", from: "58412", direction: "inbound" };
    assert.deepEqual(applyReaction([old], inbound("👍")), [{ emoji: "👍", from: "+58412", direction: "inbound" }]);
    assert.deepEqual(applyReaction([{ ...old, from: "+58412" }], inbound("")), []);
  });

  test("an empty emoji only removes", () => {
    assert.deepEqual(applyReaction([], inbound("")), []);
  });

  test("keeps other senders and the other direction", () => {
    const other = { emoji: "😀", from: "111", direction: "inbound" };
    const outbound = { emoji: "😀", from: "+58412", direction: "outbound" };
    assert.deepEqual(applyReaction([other, outbound], inbound("")), [other, outbound]);
    assert.deepEqual(applyReaction([outbound], { emoji: "", from: "+58412", direction: "outbound" }), []);
  });

  test("three-valued logic: no direction and same sender is dropped, otherwise kept", () => {
    assert.deepEqual(applyReaction([{ emoji: "x", from: "+58412" }], inbound("")), []);
    const stranger = { emoji: "x", from: "111" };
    assert.deepEqual(applyReaction([stranger], inbound("")), [stranger]);
    assert.deepEqual(applyReaction(["text", 1, null], inbound("")), ["text", 1, null]);
    assert.deepEqual(applyReaction(["text"], inbound("", "")), []);
    assert.deepEqual(applyReaction([{ direction: "inbound", from: null, emoji: "x" }], inbound("")), [{ direction: "inbound", from: null, emoji: "x" }]);
    assert.deepEqual(applyReaction([{ direction: "inbound", emoji: "x" }], inbound("", "abc")), []);
  });
});

describe("revoke", () => {
  test("merges into raw_payload, with now in jsonb format", () => {
    assert.deepEqual(revokedRawPayload({ a: 1, revoked_at: "old" }, { id: "m" }, NOW), {
      a: 1,
      revoked_at: "2026-11-06T12:00:00.123+00:00",
      revoke_event: { id: "m" },
    });
  });

  test("a NULL raw_payload starts from an empty object", () => {
    assert.deepEqual(revokedRawPayload(undefined, 1, NOW), {
      revoked_at: "2026-11-06T12:00:00.123+00:00",
      revoke_event: 1,
    });
  });
});

describe("contacts", () => {
  test("planned contact", () => {
    assert.deepEqual(planInboundContact(inboundEnvelope({ from: "+1", customerProfile: { name: " Ana " }, fromUserId: " u1 " })), {
      phone: "+1",
      name: "Ana",
      metadata: { ycloud_from_user_id: "u1" },
    });
    assert.deepEqual(planInboundContact(inboundEnvelope({ from: "+1" })), { phone: "+1", name: "+1", metadata: {} });
    assert.equal(planInboundContact(inboundEnvelope({ from: "+1", customerProfileName: "Luz" })).name, "Luz");
    assert.equal(planInboundContact(inboundEnvelope({ from: "+1", fromUserId: "  " })).metadata.ycloud_from_user_id, undefined);
  });

  test("an empty profile name hides customerProfileName", () => {
    assert.equal(planInboundContact(inboundEnvelope({ from: "+1", customerProfile: { name: "" }, customerProfileName: "Luz" })).name, "+1");
  });

  test("trim keeps tabs in the profile name", () => {
    assert.equal(planInboundContact(inboundEnvelope({ from: "+1", customerProfile: { name: "\tAna" } })).name, "\tAna");
  });

  const stored = (name: string | null, metadata: unknown = {}) => ({ name, phone_number: "+1", metadata });
  const planned = { phone: "+1", name: "Ana", metadata: {} };

  test("the name is replaced only when it was empty or the phone", () => {
    assert.equal(mergeInboundContact(stored(null), planned).name, "Ana");
    assert.equal(mergeInboundContact(stored(""), planned).name, "Ana");
    assert.equal(mergeInboundContact(stored("+1"), planned).name, "Ana");
    assert.equal(mergeInboundContact(stored("Luz"), planned).name, "Luz");
    assert.equal(mergeInboundContact(stored("  "), planned).name, "  ");
  });

  test("the new name must be real and not the phone", () => {
    assert.equal(mergeInboundContact(stored(null), { ...planned, name: "+1" }).name, null);
    assert.equal(mergeInboundContact(stored(null), { ...planned, name: "   " }).name, null);
    assert.equal(mergeInboundContact(stored(""), { ...planned, name: "" }).name, "");
  });

  test("metadata merges shallowly with the right side winning", () => {
    const merged = mergeInboundContact(stored(null, { a: 1, ycloud_from_user_id: "old" }), { ...planned, metadata: { ycloud_from_user_id: "new" } });
    assert.deepEqual(merged.metadata, { a: 1, ycloud_from_user_id: "new" });
    assert.deepEqual(mergeInboundContact(stored(null, null), planned).metadata, {});
    assert.deepEqual(mergeInboundContact(stored(null, [1]), planned).metadata, [1, {}]);
  });
});

describe("conversations", () => {
  const AT = new Date("2026-01-02T00:00:00.000Z");
  const OLDER = new Date("2020-01-01T00:00:00.000Z");

  test("new inbound conversation", () => {
    assert.deepEqual(newInboundConversation(AT, "p"), {
      lastMessageAt: "2026-01-02T00:00:00.000Z",
      lastInboundAt: "2026-01-02T00:00:00.000Z",
      windowExpiresAt: "2026-01-03T00:00:00.000Z",
      preview: "p",
      status: "open",
      unreadCount: 1,
    });
  });

  test("inbound overwrites times even when older, and counts unread", () => {
    const merged = mergeInboundConversation({ status: "open", unread_count: 5 }, OLDER, "p");
    assert.equal(merged.lastMessageAt, OLDER.toISOString());
    assert.equal(merged.lastInboundAt, OLDER.toISOString());
    assert.equal(merged.windowExpiresAt, "2020-01-02T00:00:00.000Z");
    assert.equal(merged.preview, "p");
    assert.equal(merged.unreadCount, 6);
  });

  test("only closed reopens", () => {
    assert.equal(mergeInboundConversation({ status: "closed", unread_count: 0 }, AT, "p").status, "open");
    assert.equal(mergeInboundConversation({ status: "pending", unread_count: 0 }, AT, "p").status, "pending");
    assert.equal(mergeInboundConversation({ status: "resolved", unread_count: 0 }, AT, "p").status, "resolved");
  });

  test("outbound: greatest ignores NULLs, and the preview follows the newest", () => {
    assert.deepEqual(mergeOutboundConversation({ last_message_at: null, last_message_preview: "old" }, OLDER, "new"), {
      lastMessageAt: OLDER.toISOString(),
      preview: "new",
    });
    assert.deepEqual(mergeOutboundConversation({ last_message_at: AT.toISOString(), last_message_preview: "old" }, OLDER, "new"), {
      lastMessageAt: AT.toISOString(),
      preview: "old",
    });
    assert.deepEqual(mergeOutboundConversation({ last_message_at: OLDER.toISOString(), last_message_preview: "old" }, AT, "new"), {
      lastMessageAt: AT.toISOString(),
      preview: "new",
    });
  });

  test("outbound: an equal time takes the new preview", () => {
    assert.equal(mergeOutboundConversation({ last_message_at: AT, last_message_preview: "old" }, AT, "new").preview, "new");
  });
});

describe("message merges", () => {
  const content = (body: string, media: Partial<MessageContent> = NO_MEDIA): MessageContent => ({ type: "text", body, ...NO_MEDIA, ...media });
  const MEDIA = { mediaUrl: "https://new", mediaMime: "new/mime", mediaFilename: "new.bin", mediaSha256: "newsha" };

  test("inbound: incoming values win and null keeps stored ones", () => {
    const envelope = inboundEnvelope({ id: "m", wamid: "wamid.new", status: "read", context: { id: "r" } });
    const patch = mergeInboundMessage(STORED, envelope, content("new", MEDIA));
    assert.equal(patch.status, "read");
    assert.deepEqual(patch.rawPayload, { id: "m", wamid: "wamid.new", status: "read", context: { id: "r" } });
    assert.equal(patch.wamid, "wamid.new");
    assert.equal(patch.replyTo, "r");
    assert.equal(patch.mediaUrl, "https://new");
    assert.equal(patch.mediaSha256, "newsha");
    const empty = mergeInboundMessage(STORED, inboundEnvelope({ id: "m" }), content("new"));
    assert.equal(empty.wamid, "wamid.old");
    assert.equal(empty.replyTo, "wamid.reply");
    assert.equal(empty.mediaUrl, "https://old");
    assert.equal(empty.mediaMime, "old/mime");
    assert.equal(empty.mediaFilename, "old.bin");
    assert.equal(empty.mediaSha256, "oldsha");
    assert.equal(empty.status, "received");
  });

  test("inbound: a stored placeholder or NULL body yields, to anything", () => {
    const envelope = inboundEnvelope({ id: "m" });
    const body = (stored: string | null, incoming: string) => mergeInboundMessage({ ...STORED, body: stored }, envelope, content(incoming)).body;
    assert.equal(body("old", "new"), "old");
    assert.equal(body("", "new"), "");
    assert.equal(body(null, "new"), "new");
    assert.equal(body("[text]", "new"), "new");
    assert.equal(body("[text]", "[image]"), "[image]");
    assert.equal(body("[Text]", "new"), "[Text]");
  });

  test("outbound: stored media wins, and nulls keep stored ids", () => {
    const stored = mergeOutboundMessage(STORED, outboundEnvelope({ id: "m" }), content("x", MEDIA));
    assert.equal(stored.mediaUrl, "https://old");
    assert.equal(stored.mediaMime, "old/mime");
    assert.equal(stored.mediaFilename, "old.bin");
    assert.equal(stored.mediaSha256, "oldsha");
    assert.equal(stored.wamid, "wamid.old");
    assert.equal(stored.replyTo, "wamid.reply");
    assert.equal(stored.status, "updated");
    const blank = { ...STORED, media_url: null, media_mime: null, media_filename: null, media_sha256: null };
    const filled = mergeOutboundMessage(blank, outboundEnvelope({ id: "m", wamid: "w", context: { id: "r" }, status: "sent" }), content("x", MEDIA));
    assert.equal(filled.mediaUrl, "https://new");
    assert.equal(filled.mediaSha256, "newsha");
    assert.equal(filled.wamid, "w");
    assert.equal(filled.replyTo, "r");
    assert.equal(filled.status, "sent");
  });

  test("outbound: a status can move backwards", () => {
    assert.equal(mergeOutboundMessage(STORED, outboundEnvelope({ status: "sent" }), content("x")).status, "sent");
  });

  test("outbound: a placeholder body yields only to a real one", () => {
    const envelope = outboundEnvelope({ id: "m" });
    const body = (stored: string | null, incoming: string) => mergeOutboundMessage({ ...STORED, body: stored }, envelope, content(incoming)).body;
    assert.equal(body("old", "new"), "old");
    assert.equal(body(null, "new"), "new");
    assert.equal(body("[text]", "new"), "new");
    assert.equal(body("[text]", "[image]"), "[text]");
    assert.equal(body(null, "[image]"), null);
  });

  test("outbound raw_payload: rich rows keep their blocks and merge under send", () => {
    const raw = (stored: unknown, msg: Record<string, unknown>) => mergeOutboundMessage({ ...STORED, raw_payload: stored }, outboundEnvelope(msg), content("x")).rawPayload;
    assert.deepEqual(raw({ storagePath: "p", wamid: "w0" }, { id: "m", status: "sent" }), {
      storagePath: "p",
      wamid: "w0",
      send: { id: "m", status: "sent" },
    });
    assert.deepEqual(raw({ upload: {}, send: { a: 1, id: "x" } }, { id: "wamid.1" }), {
      upload: {},
      send: { a: 1, id: "wamid.1" },
      wamid: "wamid.1",
    });
    assert.deepEqual(raw({ send: { a: 1 } }, { id: "m" }), { send: { a: 1, id: "m" }, wamid: null });
    assert.deepEqual(raw({ storagePath: null }, { id: "m" }), { storagePath: null, send: { id: "m" }, wamid: null });
  });

  test("outbound raw_payload: a jsonb null send concatenates like Postgres", () => {
    const stored = { ...STORED, raw_payload: { send: null } };
    assert.deepEqual(mergeOutboundMessage(stored, outboundEnvelope({ id: "m" }), content("x")).rawPayload, { send: [null, { id: "m" }], wamid: null });
  });

  test("outbound raw_payload: plain objects merge, everything else is replaced", () => {
    const raw = (stored: unknown, msg: unknown) => mergeOutboundMessage({ ...STORED, raw_payload: stored }, outboundEnvelope(msg), content("x")).rawPayload;
    assert.deepEqual(raw({ a: 1, status: "old" }, { status: "new" }), { a: 1, status: "new" });
    assert.deepEqual(raw(undefined, { id: "m" }), { id: "m" });
    assert.deepEqual(raw([1], { id: "m" }), { id: "m" });
    assert.equal(raw({ a: 1 }, "scalar"), "scalar");
  });
});
