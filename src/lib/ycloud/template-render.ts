/** Pure rendering of a WhatsApp template: stored definition + sent parameters. */

import { richContentText, richFromTemplate } from "./rich-content.ts";

export type SentTemplate = {
  name: string;
  language: string;
  components: unknown[];
};

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
 * Text as the customer saw it, or null when the definition has nothing to show. It feeds
 * messages.body, the preview and search; the thread draws the buttons from rich_content.
 */
export function renderTemplateText(
  definitionComponents: unknown,
  sentComponents: unknown,
): string | null {
  const rich = richFromTemplate(definitionComponents, sentComponents);
  return rich ? richContentText(rich) : null;
}
