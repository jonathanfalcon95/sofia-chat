import { test } from "node:test";
import assert from "node:assert/strict";
import { readSentTemplate, renderTemplateText } from "./template-render.ts";

const textParam = (text: string) => ({ type: "text", text });

test("renderTemplateText fills positional body parameters", () => {
  const out = renderTemplateText(
    [{ type: "BODY", text: "Hola {{1}}, tu pedido {{2}} llegó" }],
    [{ type: "body", parameters: [textParam("Ana"), textParam("A-12")] }],
  );
  assert.equal(out, "Hola Ana, tu pedido A-12 llegó");
});

test("renderTemplateText fills named parameters", () => {
  const out = renderTemplateText(
    [{ type: "BODY", text: "Hola {{first_name}}" }],
    [
      {
        type: "body",
        parameters: [{ ...textParam("Ana"), parameter_name: "first_name" }],
      },
    ],
  );
  assert.equal(out, "Hola Ana");
});

test("renderTemplateText treats replacement patterns in values literally", () => {
  const out = renderTemplateText(
    [{ type: "BODY", text: "Total: {{1}}" }],
    [{ type: "body", parameters: [textParam("$& $1 100")] }],
  );
  assert.equal(out, "Total: $& $1 100");
});

test("renderTemplateText keeps variables it has no value for", () => {
  const out = renderTemplateText(
    [{ type: "BODY", text: "Hola {{1}} y {{2}}" }],
    [{ type: "body", parameters: [textParam("Ana")] }],
  );
  assert.equal(out, "Hola Ana y {{2}}");
});

test("renderTemplateText uses currency and date fallbacks", () => {
  const out = renderTemplateText(
    [{ type: "BODY", text: "{{1}} el {{2}}" }],
    [
      {
        type: "body",
        parameters: [
          { type: "currency", currency: { fallback_value: "$10" } },
          { type: "date_time", date_time: { fallback_value: "lunes" } },
        ],
      },
    ],
  );
  assert.equal(out, "$10 el lunes");
});

test("renderTemplateText joins header, body, footer and buttons", () => {
  const out = renderTemplateText(
    [
      { type: "HEADER", format: "TEXT", text: "Pedido {{1}}" },
      { type: "BODY", text: "Listo" },
      { type: "FOOTER", text: "Gracias" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Sí" },
          { type: "QUICK_REPLY", text: "No" },
        ],
      },
    ],
    [{ type: "header", parameters: [textParam("A-12")] }],
  );
  assert.equal(out, "Pedido A-12\n\nListo\n\nGracias\n\n🔘 Sí\n🔘 No");
});

test("renderTemplateText labels media headers", () => {
  const out = renderTemplateText(
    [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Mira" },
    ],
    [],
  );
  assert.equal(out, "📎 Imagen\n\nMira");
});

test("renderTemplateText ignores the sent quick-reply payload parameters", () => {
  const out = renderTemplateText(
    [{ type: "BODY", text: "Hola {{1}}" }],
    [
      { type: "body", parameters: [textParam("Ana")] },
      {
        type: "button",
        sub_type: "quick_reply",
        parameters: [{ type: "payload", payload: "SECRET" }],
      },
    ],
  );
  assert.equal(out, "Hola Ana");
});

test("renderTemplateText returns null without usable text", () => {
  assert.equal(renderTemplateText([], []), null);
  assert.equal(renderTemplateText(null, null), null);
  assert.equal(renderTemplateText([{ type: "BODY", text: "[template]" }], []), null);
});

test("readSentTemplate reads the webhook template object", () => {
  const components = [{ type: "body", parameters: [] }];
  assert.deepEqual(
    readSentTemplate({
      template: { name: "aviso", language: { code: "es" }, components },
    }),
    { name: "aviso", language: "es", components },
  );
});

test("readSentTemplate accepts a plain language and the nested send payload", () => {
  assert.deepEqual(
    readSentTemplate({ send: { template: { name: "aviso", language: "es_MX" } } }),
    { name: "aviso", language: "es_MX", components: [] },
  );
});

test("readSentTemplate rejects payloads without name or language", () => {
  assert.equal(readSentTemplate({ type: "template" }), null);
  assert.equal(readSentTemplate({ template: { name: "aviso" } }), null);
  assert.equal(readSentTemplate(null), null);
});
