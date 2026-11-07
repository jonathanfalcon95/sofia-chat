/**
 * What a template or interactive message showed the customer: header, text and buttons. Pure, so
 * the webhook, the template enrichment and the backfill agree, and the thread can draw buttons.
 * Stored in messages.rich_content; raw_payload never reaches the browser.
 */

export type RichHeader =
  | { type: "text"; text: string }
  | { type: "image" | "video" | "document" | "location" };

export type RichButtonKind = "url" | "phone" | "reply" | "copy_code" | "flow" | "other";

export type RichButton = {
  kind: RichButtonKind;
  text: string;
  url?: string;
  phone?: string;
  code?: string;
};

export type RichListSection = {
  title?: string;
  rows: Array<{ title: string; description?: string }>;
};

export type RichContent = {
  kind: "template" | "interactive" | "button_reply" | "list_reply" | "form_reply";
  header?: RichHeader;
  body?: string;
  footer?: string;
  buttons?: RichButton[];
  list?: { button: string; sections: RichListSection[] };
};

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStr(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asObjArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const obj = asObj(item);
    return obj ? [obj] : [];
  });
}

function upper(value: unknown) {
  return String(value ?? "").toUpperCase();
}

const MEDIA_HEADERS = new Set(["image", "video", "document", "location"]);

function mediaHeader(format: string): RichHeader | undefined {
  const type = format.toLowerCase();
  return MEDIA_HEADERS.has(type) ? ({ type } as RichHeader) : undefined;
}

/** Only links a browser can open safely become clickable. */
export function safeHttpUrl(value: unknown): string | null {
  const text = asStr(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function compact(content: RichContent): RichContent | null {
  const result: RichContent = { kind: content.kind };
  if (content.header) result.header = content.header;
  if (content.body) result.body = content.body;
  if (content.footer) result.footer = content.footer;
  if (content.buttons?.length) result.buttons = content.buttons;
  if (content.list?.sections.some((s) => s.rows.length > 0)) result.list = content.list;
  const hasContent =
    result.header || result.body || result.footer || result.buttons || result.list;
  return hasContent ? result : null;
}

// Templates ------------------------------------------------------------------

function parameterValue(parameter: Record<string, unknown>): string | null {
  const type = String(parameter.type ?? "text").toLowerCase();
  if (type === "text") return asStr(parameter.text);
  if (type === "payload") return asStr(parameter.payload);
  if (type === "coupon_code") return asStr(parameter.coupon_code);
  if (type === "currency") return asStr(asObj(parameter.currency)?.fallback_value);
  if (type === "date_time") return asStr(asObj(parameter.date_time)?.fallback_value);
  return null;
}

/** Unresolved variables stay as {{n}} so the gap is visible, not silently blank. */
export function fillVariables(text: string, parameters: Array<Record<string, unknown>>) {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key: string) => {
    const parameter = /^\d+$/.test(key)
      ? parameters[Number(key) - 1]
      : parameters.find((p) => p.parameter_name === key);
    return (parameter && parameterValue(parameter)) ?? match;
  });
}

function templateButton(
  definition: Record<string, unknown>,
  sent: Record<string, unknown> | undefined,
): RichButton | null {
  const type = upper(definition.type);
  const parameters = asObjArray(sent?.parameters);
  const text = asStr(definition.text);
  switch (type) {
    case "URL": {
      const template = asStr(definition.url);
      const filled = template ? fillVariables(template, parameters) : null;
      // A link with a variable left open would take the customer somewhere else.
      const url = filled && !/\{\{/.test(filled) ? safeHttpUrl(filled) : null;
      return { kind: "url", text: text ?? "Abrir enlace", ...(url ? { url } : {}) };
    }
    case "PHONE_NUMBER": {
      const phone = asStr(definition.phone_number);
      return { kind: "phone", text: text ?? "Llamar", ...(phone ? { phone } : {}) };
    }
    case "QUICK_REPLY":
      return text ? { kind: "reply", text } : null;
    case "COPY_CODE":
    case "OTP": {
      const code = parameters.map(parameterValue).find((v) => v !== null) ?? undefined;
      return { kind: "copy_code", text: text ?? "Copiar código", ...(code ? { code } : {}) };
    }
    case "FLOW":
      return { kind: "flow", text: text ?? "Abrir formulario" };
    default:
      return text ? { kind: "other", text } : null;
  }
}

/** The definition from YCloud filled with the parameters sent, or null when it has nothing. */
export function richFromTemplate(
  definitionComponents: unknown,
  sentComponents: unknown,
): RichContent | null {
  const definition = asObjArray(definitionComponents);
  const sent = asObjArray(sentComponents);
  const parametersOf = (type: string) =>
    asObjArray(sent.find((c) => upper(c.type) === type)?.parameters);

  const content: RichContent = { kind: "template" };

  const header = definition.find((c) => upper(c.type) === "HEADER");
  if (header) {
    const format = upper(header.format ?? "TEXT");
    const text = asStr(header.text);
    content.header =
      format === "TEXT"
        ? text
          ? { type: "text", text: fillVariables(text, parametersOf("HEADER")) }
          : undefined
        : mediaHeader(format);
  }

  const body = asStr(definition.find((c) => upper(c.type) === "BODY")?.text);
  if (body) content.body = fillVariables(body, parametersOf("BODY"));

  const footer = asStr(definition.find((c) => upper(c.type) === "FOOTER")?.text);
  if (footer) content.footer = footer;

  const sentButtons = sent.filter((c) => upper(c.type) === "BUTTON");
  content.buttons = asObjArray(
    definition.find((c) => upper(c.type) === "BUTTONS")?.buttons,
  ).flatMap((button, index) => {
    const match = sentButtons.find((c) => Number(c.index) === index);
    return templateButton(button, match) ?? [];
  });

  return compact(content);
}

// Interactive and replies ----------------------------------------------------

function interactiveHeader(value: unknown): RichHeader | undefined {
  const header = asObj(value);
  if (!header) return undefined;
  const type = String(header.type ?? "text").toLowerCase();
  if (type === "text") {
    const text = asStr(header.text);
    return text ? { type: "text", text } : undefined;
  }
  return mediaHeader(type);
}

function listSections(value: unknown): RichListSection[] {
  return asObjArray(value).map((section) => {
    const title = asStr(section.title);
    return {
      ...(title ? { title } : {}),
      rows: asObjArray(section.rows).flatMap((row) => {
        const rowTitle = asStr(row.title);
        if (!rowTitle) return [];
        const description = asStr(row.description);
        return [{ title: rowTitle, ...(description ? { description } : {}) }];
      }),
    };
  });
}

function richFromInteractive(interactive: Record<string, unknown>): RichContent | null {
  const type = String(interactive.type ?? "").toLowerCase();

  const buttonReply = asObj(interactive.button_reply);
  if (type === "button_reply" || buttonReply) {
    return compact({ kind: "button_reply", body: asStr(buttonReply?.title) ?? undefined });
  }
  const listReply = asObj(interactive.list_reply);
  if (type === "list_reply" || listReply) {
    const description = asStr(listReply?.description);
    return compact({
      kind: "list_reply",
      body: asStr(listReply?.title) ?? undefined,
      ...(description ? { footer: description } : {}),
    });
  }
  if (type === "nfm_reply" || interactive.nfm_reply) {
    return { kind: "form_reply", body: "Formulario enviado" };
  }

  const action = asObj(interactive.action);
  const parameters = asObj(action?.parameters);
  const content: RichContent = {
    kind: "interactive",
    header: interactiveHeader(interactive.header),
    body: asStr(asObj(interactive.body)?.text) ?? undefined,
    footer: asStr(asObj(interactive.footer)?.text) ?? undefined,
  };

  const buttons: RichButton[] = asObjArray(action?.buttons).flatMap((button) => {
    const title = asStr(asObj(button.reply)?.title) ?? asStr(button.title);
    return title ? [{ kind: "reply" as const, text: title }] : [];
  });

  const url = safeHttpUrl(parameters?.url);
  if (asStr(parameters?.url)) {
    buttons.push({
      kind: "url",
      text: asStr(parameters?.display_text) ?? "Abrir enlace",
      ...(url ? { url } : {}),
    });
  }
  if (type === "flow" || action?.name === "flow") {
    buttons.push({ kind: "flow", text: asStr(parameters?.flow_cta) ?? "Abrir formulario" });
  }
  content.buttons = buttons;

  if (Array.isArray(action?.sections)) {
    content.list = {
      button: asStr(action?.button) ?? "Ver opciones",
      sections: listSections(action?.sections),
    };
  }
  return compact(content);
}

/**
 * Rich content a message carries by itself: interactive messages and the customer's replies.
 * Templates need their definition from YCloud, so they go through `richFromTemplate`.
 */
export function richFromMessage(message: unknown): RichContent | null {
  const msg = asObj(message);
  if (!msg) return null;
  const type = String(msg.type ?? "");
  if (type === "button") {
    const text = asStr(asObj(msg.button)?.text);
    return text ? { kind: "button_reply", body: text } : null;
  }
  if (type === "interactive") {
    const interactive = asObj(msg.interactive);
    return interactive ? richFromInteractive(interactive) : null;
  }
  return null;
}

// Reading back ---------------------------------------------------------------

/** Accepts only the stored shape, so a bad row can't break the thread. */
export function parseRichContent(value: unknown): RichContent | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const obj = asObj(parsed);
  if (!obj || typeof obj.kind !== "string") return null;
  return obj as unknown as RichContent;
}

// Text -----------------------------------------------------------------------

const MEDIA_HEADER_LABELS: Record<string, string> = {
  image: "📎 Imagen",
  video: "📎 Video",
  document: "📎 Documento",
  location: "📍 Ubicación",
};

/** Plain text for previews and search; buttons become lines. */
export function richContentText(content: RichContent): string | null {
  const sections: string[] = [];
  if (content.header) {
    sections.push(
      content.header.type === "text" ? content.header.text : MEDIA_HEADER_LABELS[content.header.type],
    );
  }
  if (content.body) sections.push(content.body);
  if (content.footer) sections.push(content.footer);
  if (content.buttons?.length) {
    sections.push(content.buttons.map((button) => `🔘 ${button.text}`).join("\n"));
  }
  const text = sections.join("\n\n").trim();
  // A bare "[word]" would be read as a type placeholder by SQL and the UI.
  if (!text || /^\[[a-z_0-9]+\]$/i.test(text)) return null;
  return text;
}
