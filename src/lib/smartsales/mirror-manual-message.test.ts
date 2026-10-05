import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mirrorManualMessage,
  toSmartSalesPhone,
  type MirrorManualMessageDeps,
} from "./mirror-manual-message.ts";

const BASE = "https://smartsales.test";
const TOKEN = "test-token";
const PHONE = "+584121234567";
const NOW = new Date("2026-10-05T22:20:00.000Z");

test("toSmartSalesPhone keeps a leading plus and drops separators", () => {
  assert.equal(toSmartSalesPhone("584121234567"), PHONE);
  assert.equal(toSmartSalesPhone("+58 412 1234567"), PHONE);
  assert.equal(toSmartSalesPhone(" +58 412 123 4567 "), PHONE);
  assert.equal(toSmartSalesPhone("%2B584121234567"), PHONE);
  assert.equal(toSmartSalesPhone("abc"), "");
  assert.equal(toSmartSalesPhone(""), "");
});

test("posts the typed text when GetLast returns a conversation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await mirrorManualMessage(
    { phoneNumber: " +58 412 1234567 ", content: " Hola " },
    {
      ...deps(calls, async (url) => {
        if (url.includes("GetLastByPhoneNumber")) {
          assert.match(url, /phoneNumber=%2B584121234567$/);
          return json(200, {
            err: false,
            message: "",
            data: { idConversation: 42796, idBot: "bot-1" },
          });
        }
        return json(201, { err: false });
      }),
      now: () => NOW,
    },
  );

  assert.deepEqual(result, {
    ok: true,
    skipped: false,
    idConversation: 42796,
  });
  assert.equal(calls.length, 2);
  const post = calls[1]!;
  assert.equal(post.url, `${BASE}/Conversations/CreateMessage`);
  assert.equal(post.init?.method, "POST");
  const headers = new Headers(post.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(post.init?.body)), {
    idConversation: 42796,
    message: [
      {
        idBot: "bot-1",
        sender: "assistant",
        timestamp: "2026-10-05T22:20:00.000Z",
        content: "Hola",
        urlMedia: null,
      },
    ],
  });
});

test("sends a null idBot when the lookup omits it", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await mirrorManualMessage(
    { phoneNumber: PHONE, content: "Hola" },
    deps(calls, async (url) => {
      if (url.includes("GetLastByPhoneNumber")) {
        return json(200, {
          err: false,
          data: { idConversation: 12, idBot: null },
        });
      }
      return json(201, { err: false });
    }),
  );
  const body = JSON.parse(String(calls[1]?.init?.body)) as {
    message: Array<{ idBot: string | null }>;
  };
  assert.equal(body.message[0]?.idBot, null);
});

test("does not create a message when the conversation is missing", async () => {
  for (const lookup of [
    json(404, {
      err: true,
      message: "No se encontró una conversación",
      data: null,
    }),
    json(200, { err: true, data: null }),
    json(200, { err: false, data: null }),
  ]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await mirrorManualMessage(
      { phoneNumber: PHONE, content: "Hola" },
      deps(calls, async () => lookup),
    );
    assert.deepEqual(result, {
      ok: true,
      skipped: true,
      reason: "no_conversation",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /GetLastByPhoneNumber/);
  }
});

test("missing token, upstream errors, network, and timeout do not throw", async () => {
  const missing = await mirrorManualMessage(
    { phoneNumber: PHONE, content: "Hola" },
    { token: "", fetch: async () => json(200, {}) },
  );
  assert.deepEqual(missing, { ok: false, reason: "missing_token" });

  const lookupFailed = await mirrorManualMessage(
    { phoneNumber: PHONE, content: "Hola" },
    deps([], async () => json(500, { err: true })),
  );
  assert.deepEqual(lookupFailed, { ok: false, reason: "lookup_failed" });

  const createFailed = await mirrorManualMessage(
    { phoneNumber: PHONE, content: "Hola" },
    deps([], async (url) => {
      if (url.includes("GetLastByPhoneNumber")) {
        return json(200, {
          err: false,
          data: { idConversation: 9, idBot: "bot-1" },
        });
      }
      return json(500, { err: true });
    }),
  );
  assert.deepEqual(createFailed, { ok: false, reason: "create_failed" });

  const network = await mirrorManualMessage(
    { phoneNumber: PHONE, content: "Hola" },
    deps([], async () => {
      throw new Error("network down");
    }),
  );
  assert.deepEqual(network, { ok: false, reason: "request_failed" });

  const timedOut = await mirrorManualMessage(
    { phoneNumber: PHONE, content: "Hola" },
    deps(
      [],
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      30,
    ),
  );
  assert.deepEqual(timedOut, { ok: false, reason: "request_failed" });
});

test("empty content or a phone without digits never calls the API", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return json(200, {});
  };
  const emptyText = await mirrorManualMessage(
    { phoneNumber: PHONE, content: "   " },
    { token: TOKEN, baseUrl: BASE, fetch: fetchImpl },
  );
  const emptyPhone = await mirrorManualMessage(
    { phoneNumber: "sin-numero", content: "Hola" },
    { token: TOKEN, baseUrl: BASE, fetch: fetchImpl },
  );
  assert.deepEqual(emptyText, { ok: true, skipped: true, reason: "empty_input" });
  assert.deepEqual(emptyPhone, {
    ok: true,
    skipped: true,
    reason: "empty_input",
  });
  assert.equal(calls, 0);
});

function deps(
  calls: Array<{ url: string; init?: RequestInit }>,
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  timeoutMs = 8_000,
): MirrorManualMessageDeps {
  return {
    token: TOKEN,
    baseUrl: BASE,
    timeoutMs,
    now: () => NOW,
    fetch: async (url, init) => {
      const href = String(url);
      calls.push({ url: href, init });
      return handler(href, init);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
