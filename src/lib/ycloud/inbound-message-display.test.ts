import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInboundBody,
  extractEditedMessage,
  extractLocationDetails,
  formatContactsCard,
  formatInteractiveCta,
  formatLocationMessage,
  formatOrderMessage,
  formatSystemMessage,
  formatUnsupportedMessage,
  mediaContentDisposition,
  sanitizeMessageBody,
} from "./inbound-message-display.ts";
import { whatsappDeepLink } from "../conversations/phone-digits.ts";

test("formatInteractiveCta builds body + labeled url", () => {
  const body = formatInteractiveCta({
    interactive: {
      body: { text: "Para ver los uniformes, ve a nuestro catálogo." },
      type: "cta_url",
      action: {
        name: "cta_url",
        parameters: {
          url: "https://www.agentesofiacatalog.com/?guid=86",
          display_text: "Ver catálogo",
        },
      },
    },
  });
  assert.match(body, /Para ver los uniformes/);
  assert.match(body, /Ver catálogo: https:\/\/www\.agentesofiacatalog\.com/);
});

test("formatContactsCard lists name and phones", () => {
  const body = formatContactsCard({
    contacts: [
      {
        name: { formatted_name: "Dr Rafael Cardiovascular" },
        phones: [{ type: "Móvil", phone: "+58 424-1601675", wa_id: "584241601675" }],
      },
    ],
  });
  assert.match(body, /Dr Rafael Cardiovascular/);
  assert.match(body, /Móvil: \+58 424-1601675/);
});

test("formatSystemMessage user_changed_number", () => {
  const body = formatSystemMessage({
    system: {
      type: "user_changed_number",
      wa_id: "584143548919",
      body: "User A changed from 584164501777 to 584143548919",
    },
  });
  assert.equal(body, "El contacto cambió de número a +584143548919");
});

test("unsupported and edit extraction", () => {
  assert.equal(
    formatUnsupportedMessage(),
    "WhatsApp no compartió este mensaje (tipo no disponible para negocios).",
  );
  const edited = extractEditedMessage({
    text: { body: "piretatiana@gmail.com" },
    type: "text",
  });
  assert.equal(edited.type, "text");
  assert.equal(edited.body, "piretatiana@gmail.com");

  const imageEdit = extractEditedMessage({
    type: "image",
    image: {
      link: "https://example.com/x.jpg",
      mime_type: "image/jpeg",
      caption: "Nombre y Apellido: Felicita",
      sha256: "abc",
    },
  });
  assert.equal(imageEdit.type, "image");
  assert.equal(imageEdit.body, "Nombre y Apellido: Felicita");
  assert.equal(imageEdit.mediaUrl, "https://example.com/x.jpg");
});

test("buildInboundBody dispatches by type", () => {
  assert.equal(
    buildInboundBody("unsupported", {}),
    formatUnsupportedMessage(),
  );
  assert.match(
    buildInboundBody("interactive", {
      interactive: {
        body: { text: "Hola" },
        action: { parameters: { url: "https://x.test", display_text: "Ir" } },
      },
    }),
    /Ir: https:\/\/x\.test/,
  );
});

test("mediaContentDisposition attachment vs inline", () => {
  assert.equal(
    mediaContentDisposition("informe.pdf", "document", true),
    'attachment; filename="informe.pdf"',
  );
  assert.equal(
    mediaContentDisposition(null, "image", false),
    'inline; filename="imagen.jpg"',
  );
});

test("whatsappDeepLink normalizes phone", () => {
  assert.equal(whatsappDeepLink("+58 424-1889634"), "https://wa.me/584241889634");
  assert.equal(whatsappDeepLink(""), null);
  assert.equal(whatsappDeepLink(null), null);
});

test("formatLocationMessage formats name and coords", () => {
  const loc = {
    location: {
      name: "Tienda Centro",
      address: "Av. Principal 123",
      latitude: 10.0614,
      longitude: -69.292,
    },
  };
  assert.equal(formatLocationMessage(loc), "📍 Tienda Centro\nAv. Principal 123");
  const extracted = extractLocationDetails(loc);
  assert.equal(extracted?.latitude, 10.0614);
  assert.equal(extracted?.name, "Tienda Centro");

  const rawCoords = { location: { latitude: 10.1, longitude: -69.2 } };
  assert.equal(formatLocationMessage(rawCoords), "📍 Ubicación: 10.1, -69.2");
});

test("formatOrderMessage formats catalog orders", () => {
  const order = {
    order: {
      text: "",
      product_items: [{ quantity: 1 }, { quantity: 2 }],
    },
  };
  assert.equal(formatOrderMessage(order), "🛒 Pedido de catálogo (2 artículos)");
});

test("sanitizeMessageBody converts brackets to human labels", () => {
  assert.equal(sanitizeMessageBody("[image]"), "Imagen");
  assert.equal(sanitizeMessageBody("[interactive]"), "Mensaje interactivo");
  assert.equal(sanitizeMessageBody("[location]"), "Ubicación");
  assert.equal(sanitizeMessageBody("[audio]"), "Nota de voz");
  assert.equal(sanitizeMessageBody("Hola mundo"), "Hola mundo");
  assert.equal(sanitizeMessageBody(null, "image"), "Imagen");
});
