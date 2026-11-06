/** Pure rendering of a WhatsApp template: stored definition + sent parameters. */

export type SentTemplate = {
  name: string;
  language: string;
  components: unknown[];
};

const MEDIA_HEADER_LABELS: Record<string, string> = {
  IMAGE: "📎 Imagen",
  VIDEO: "📎 Video",
  DOCUMENT: "📎 Documento",
  LOCATION: "📍 Ubicación",
};

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asObjArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const obj = asObj(item);
    return obj ? [obj] : [];
  });
}

function componentType(component: Record<string, unknown>) {
  return String(component.type ?? "").toUpperCase();
}

function parameterValue(parameter: Record<string, unknown>): string | null {
  const type = String(parameter.type ?? "text").toLowerCase();
  if (type === "text") return asStr(parameter.text);
  if (type === "currency") return asStr(asObj(parameter.currency)?.fallback_value);
  if (type === "date_time") {
    return asStr(asObj(parameter.date_time)?.fallback_value);
  }
  return null;
}

/** Unresolved variables stay as {{n}} so the gap is visible, not silently blank. */
function fillVariables(text: string, parameters: Array<Record<string, unknown>>) {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key: string) => {
    const parameter = /^\d+$/.test(key)
      ? parameters[Number(key) - 1]
      : parameters.find((p) => p.parameter_name === key);
    return (parameter && parameterValue(parameter)) ?? match;
  });
}

/** Reads the template object a message webhook carries. */
export function readSentTemplate(message: unknown): SentTemplate | null {
  const msg = asObj(message);
  const template = asObj(msg?.template) ?? asObj(asObj(msg?.send)?.template);
  const name = asStr(template?.name);
  if (!template || !name) return null;
  const language = asObj(template.language)
    ? asStr(asObj(template.language)?.code)
    : asStr(template.language);
  if (!language) return null;
  return {
    name,
    language,
    components: Array.isArray(template.components) ? template.components : [],
  };
}

/**
 * Text as the customer saw it, or null when the definition has nothing to show.
 * Buttons become plain lines because the thread only renders messages.body.
 */
export function renderTemplateText(
  definitionComponents: unknown,
  sentComponents: unknown,
): string | null {
  const definition = asObjArray(definitionComponents);
  const sent = asObjArray(sentComponents);
  const parametersOf = (type: string) =>
    asObjArray(sent.find((c) => componentType(c) === type)?.parameters);

  const sections: string[] = [];

  const header = definition.find((c) => componentType(c) === "HEADER");
  if (header) {
    const format = String(header.format ?? "TEXT").toUpperCase();
    const headerText = asStr(header.text);
    if (format === "TEXT" && headerText) {
      sections.push(fillVariables(headerText, parametersOf("HEADER")));
    } else if (MEDIA_HEADER_LABELS[format]) {
      sections.push(MEDIA_HEADER_LABELS[format]);
    }
  }

  const bodyText = asStr(definition.find((c) => componentType(c) === "BODY")?.text);
  if (bodyText) sections.push(fillVariables(bodyText, parametersOf("BODY")));

  const footerText = asStr(definition.find((c) => componentType(c) === "FOOTER")?.text);
  if (footerText) sections.push(footerText);

  const buttons = asObjArray(
    definition.find((c) => componentType(c) === "BUTTONS")?.buttons,
  ).flatMap((button) => asStr(button.text) ?? []);
  if (buttons.length > 0) {
    sections.push(buttons.map((text) => `🔘 ${text}`).join("\n"));
  }

  const rendered = sections.join("\n\n").trim();
  // A bare "[word]" would be read as a type placeholder by SQL and the UI.
  if (!rendered || /^\[[a-z_0-9]+\]$/i.test(rendered)) return null;
  return rendered;
}
