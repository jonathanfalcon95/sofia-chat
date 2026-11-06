import { getSystemDb } from "@/lib/db/client";
import {
  getConversationInbox,
  listEnrichableMessagesByYCloudIds,
  updateConversationPreviewIfUnchanged,
  updateMessageBodyIfUnchanged,
} from "@/lib/db/repos/messaging";
import type { Db } from "@/lib/db/types";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";
import { getWhatsAppTemplate } from "@/lib/ycloud/client";
import { extractReplyText } from "@/lib/ycloud/inbound-message-display";
import {
  readSentTemplate,
  renderTemplateText,
} from "@/lib/ycloud/template-render";

/**
 * Fills in text process_ycloud_event can't produce on its own: template bodies,
 * which need the definition from YCloud, and customers' button replies.
 */

export type EnrichableMessage = {
  id: string;
  type: string;
  body: string | null;
  conversation_id: string;
  created_at: string;
};

export type ResolvedText = {
  body: string;
  templateName?: string;
  source: "template" | "template_fallback" | "reply";
};

export { ENRICHABLE_MESSAGE_SELECT } from "@/lib/db/repos/messaging";

const DEFINITION_TTL_MS = 10 * 60 * 1000;
const definitionCache = new Map<
  string,
  { components: unknown; expiresAt: number }
>();

async function loadTemplateComponents(args: {
  apiKey: string;
  wabaId: string;
  name: string;
  language: string;
}) {
  const key = `${args.wabaId}/${args.name}/${args.language}`;
  const cached = definitionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.components;
  const definition = await getWhatsAppTemplate(args);
  definitionCache.set(key, {
    components: definition.components,
    expiresAt: Date.now() + DEFINITION_TTL_MS,
  });
  return definition.components;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function resolveTemplateText(
  db: Db,
  row: EnrichableMessage,
  message: Record<string, unknown>,
): Promise<ResolvedText | null> {
  const sent = readSentTemplate(message);
  if (!sent) return null;

  const fallbackBody = `Plantilla: ${sent.name}`;
  // The fallback stays eligible so later status webhooks can still upgrade it.
  if (row.body !== "[template]" && row.body !== fallbackBody) return null;

  const fallback: ResolvedText = {
    body: fallbackBody,
    templateName: sent.name,
    source: "template_fallback",
  };

  try {
    const { data: conversation, error } = await getConversationInbox(
      db,
      row.conversation_id,
    );
    if (error) throw new Error(error.message);

    const credentials = await getInboxYCloudCredentials(
      conversation.inbox_id as string,
    );
    const wabaId = isString(message.wabaId) ? message.wabaId : credentials.wabaId;
    if (!wabaId) return fallback;

    const components = await loadTemplateComponents({
      apiKey: credentials.apiKey,
      wabaId,
      name: sent.name,
      language: sent.language,
    });
    const rendered = renderTemplateText(components, sent.components);
    return rendered
      ? { body: rendered, templateName: sent.name, source: "template" }
      : fallback;
  } catch (err) {
    console.warn(
      `[message-enrichment] template ${sent.name}/${sent.language}:`,
      err instanceof Error ? err.message : err,
    );
    return fallback;
  }
}

/** Text to store for a placeholder message, or null when there's nothing to do. */
export async function resolveMessageText(
  db: Db,
  row: EnrichableMessage,
  message: Record<string, unknown>,
): Promise<ResolvedText | null> {
  if (row.type === "template") return resolveTemplateText(db, row, message);

  const isReplyPlaceholder =
    (row.type === "button" && row.body === "[button]") ||
    (row.type === "interactive" &&
      (row.body === "[interactive]" || row.body === "Mensaje interactivo"));
  if (!isReplyPlaceholder) return null;

  const reply = extractReplyText(message);
  return reply ? { body: reply, source: "reply" } : null;
}

/** Writes only if the row still holds what was read, so nothing newer is lost. */
export async function applyResolvedText(
  db: Db,
  row: EnrichableMessage,
  resolved: ResolvedText,
) {
  if (row.body === null) return;

  if (resolved.body !== row.body) {
    const { error } = await updateMessageBodyIfUnchanged(db, row.id, row.body, {
      body: resolved.body,
      ...(resolved.templateName ? { template_name: resolved.templateName } : {}),
    });
    if (error) throw new Error(error.message);
  }

  const { error: previewError } = await updateConversationPreviewIfUnchanged(
    db,
    row.conversation_id,
    resolved.body.slice(0, 200),
    row.body.slice(0, 200),
    row.created_at,
  );
  if (previewError) throw new Error(previewError.message);
}

const ENRICHABLE_TYPES = new Set(["template", "button", "interactive"]);

/** Webhook entry point; runs after the response, so it can't delay or fail it. */
export async function enrichMessageTextFromWebhook(
  payload: Record<string, unknown>,
) {
  const message = (payload.whatsappInboundMessage || payload.whatsappMessage) as
    | Record<string, unknown>
    | undefined;
  if (!message || !ENRICHABLE_TYPES.has(String(message.type))) return;

  const ids = [message.id, message.wamid]
    .map((v) => (v == null ? "" : String(v)))
    .filter(Boolean);
  if (ids.length === 0) return;

  const db = getSystemDb();
  // Status webhooks repeat for every message; this check keeps them API-free.
  const { data: rows, error } = await listEnrichableMessagesByYCloudIds(db, ids);
  if (error) throw new Error(error.message);

  const row = rows?.[0] as EnrichableMessage | undefined;
  if (!row) return;

  const resolved = await resolveMessageText(db, row, message);
  if (resolved) await applyResolvedText(db, row, resolved);
}
