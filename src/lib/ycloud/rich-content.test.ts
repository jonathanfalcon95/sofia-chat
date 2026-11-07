import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRichContent,
  richContentText,
  richFromMessage,
  richFromTemplate,
  safeHttpUrl,
} from "./rich-content.ts";

describe("richFromMessage", () => {
  test("a link button keeps its text and label, without the url in the text", () => {
    const rich = richFromMessage({
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: "Mira el catálogo" },
        footer: { text: "Tienda" },
        action: { name: "cta_url", parameters: { display_text: "Ver catálogo", url: "https://example.com/c" } },
      },
    });
    assert.deepEqual(rich, {
      kind: "interactive",
      body: "Mira el catálogo",
      footer: "Tienda",
      buttons: [{ kind: "url", text: "Ver catálogo", url: "https://example.com/c" }],
    });
  });

  test("a link button with no type still shows, and an unsafe link is not clickable", () => {
    const rich = richFromMessage({
      type: "interactive",
      interactive: { action: { parameters: { url: "javascript:alert(1)" } }, body: { text: "Hola" } },
    });
    assert.deepEqual(rich?.buttons, [{ kind: "url", text: "Abrir enlace" }]);
  });

  test("reply buttons and a text header", () => {
    const rich = richFromMessage({
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Pedido" },
        body: { text: "¿Confirmas?" },
        action: { buttons: [{ type: "reply", reply: { id: "a", title: "Sí" } }, { type: "reply", reply: { id: "b", title: "No" } }] },
      },
    });
    assert.deepEqual(rich, {
      kind: "interactive",
      header: { type: "text", text: "Pedido" },
      body: "¿Confirmas?",
      buttons: [{ kind: "reply", text: "Sí" }, { kind: "reply", text: "No" }],
    });
  });

  test("a list keeps its sections and rows", () => {
    const rich = richFromMessage({
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Elige" },
        action: { button: "Ver menú", sections: [{ title: "Pizzas", rows: [{ id: "1", title: "Margarita", description: "Queso" }, { id: "2" }] }] },
      },
    });
    assert.deepEqual(rich?.list, {
      button: "Ver menú",
      sections: [{ title: "Pizzas", rows: [{ title: "Margarita", description: "Queso" }] }],
    });
  });

  test("the customer's replies", () => {
    assert.deepEqual(richFromMessage({ type: "button", button: { text: "Me interesa", payload: "X" } }), {
      kind: "button_reply",
      body: "Me interesa",
    });
    assert.deepEqual(
      richFromMessage({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "a", title: "Sí" } } }),
      { kind: "button_reply", body: "Sí" },
    );
    assert.deepEqual(
      richFromMessage({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "1", title: "Margarita", description: "Queso" } } }),
      { kind: "list_reply", body: "Margarita", footer: "Queso" },
    );
    assert.deepEqual(
      richFromMessage({ type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } }),
      { kind: "form_reply", body: "Formulario enviado" },
    );
  });

  test("nothing for other types or empty messages", () => {
    assert.equal(richFromMessage({ type: "text", text: { body: "hola" } }), null);
    assert.equal(richFromMessage({ type: "template", template: { name: "x" } }), null);
    assert.equal(richFromMessage({ type: "interactive", interactive: { body: { text: "  " } } }), null);
    assert.equal(richFromMessage({ type: "button", button: {} }), null);
    assert.equal(richFromMessage(null), null);
  });
});

describe("richFromTemplate", () => {
  const definition = [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Hola {{1}}, tu código es {{2}}" },
    { type: "FOOTER", text: "No respondas" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Ver pedido", url: "https://example.com/p/{{1}}" },
        { type: "PHONE_NUMBER", text: "Llamar", phone_number: "+580000000" },
        { type: "QUICK_REPLY", text: "Gracias" },
        { type: "COPY_CODE", example: "ABC" },
      ],
    },
  ];
  const sent = [
    { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "99" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "A-12" }] },
    { type: "button", sub_type: "COPY_CODE", index: 3, parameters: [{ type: "coupon_code", coupon_code: "SAVE10" }] },
  ];

  test("fills the body and each button, by index", () => {
    assert.deepEqual(richFromTemplate(definition, sent), {
      kind: "template",
      header: { type: "image" },
      body: "Hola Ana, tu código es 99",
      footer: "No respondas",
      buttons: [
        { kind: "url", text: "Ver pedido", url: "https://example.com/p/A-12" },
        { kind: "phone", text: "Llamar", phone: "+580000000" },
        { kind: "reply", text: "Gracias" },
        { kind: "copy_code", text: "Copiar código", code: "SAVE10" },
      ],
    });
  });

  test("the text keeps the format the thread used before", () => {
    const rich = richFromTemplate(definition, sent);
    assert.ok(rich);
    assert.equal(
      richContentText(rich),
      "📎 Imagen\n\nHola Ana, tu código es 99\n\nNo respondas\n\n🔘 Ver pedido\n🔘 Llamar\n🔘 Gracias\n🔘 Copiar código",
    );
  });

  test("a link with an unfilled variable is shown but not clickable", () => {
    const rich = richFromTemplate(
      [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://example.com/{{1}}" }] }],
      [],
    );
    assert.deepEqual(rich?.buttons, [{ kind: "url", text: "Ver" }]);
  });

  test("null when the definition has nothing", () => {
    assert.equal(richFromTemplate([], []), null);
    assert.equal(richFromTemplate(null, null), null);
  });
});

describe("helpers", () => {
  test("safeHttpUrl", () => {
    assert.equal(safeHttpUrl("https://a.com/x"), "https://a.com/x");
    assert.equal(safeHttpUrl("tel:123"), null);
    assert.equal(safeHttpUrl("not a url"), null);
    assert.equal(safeHttpUrl(null), null);
  });

  test("parseRichContent accepts the stored shape only", () => {
    assert.deepEqual(parseRichContent('{"kind":"interactive","body":"x"}'), { kind: "interactive", body: "x" });
    assert.deepEqual(parseRichContent({ kind: "template" }), { kind: "template" });
    assert.equal(parseRichContent("{bad"), null);
    assert.equal(parseRichContent({ body: "x" }), null);
    assert.equal(parseRichContent(null), null);
  });
});
