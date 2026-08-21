/** Pure helpers to turn YCloud/WhatsApp inbound payloads into display text. */

type Json = Record<string, unknown> | null | undefined;

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function formatInteractiveCta(raw: Json): string {
  const interactive = asObj(raw?.interactive);
  if (!interactive) return "Mensaje interactivo";
  const bodyText = asStr(asObj(interactive.body)?.text) || "";
  const action = asObj(interactive.action);
  const params = asObj(action?.parameters);
  const url = asStr(params?.url);
  const label = asStr(params?.display_text) || "Abrir enlace";
  if (bodyText && url) return `${bodyText}\n${label}: ${url}`;
  if (bodyText) return bodyText;
  if (url) return `${label}: ${url}`;
  return "Mensaje interactivo";
}

export function formatContactsCard(raw: Json): string {
  const contacts = Array.isArray(raw?.contacts) ? raw.contacts : [];
  if (!contacts.length) return "Contacto compartido";
  const lines: string[] = [];
  for (const item of contacts) {
    const c = asObj(item);
    if (!c) continue;
    const name = asObj(c.name);
    const formatted =
      asStr(name?.formatted_name) ||
      [asStr(name?.first_name), asStr(name?.middle_name), asStr(name?.last_name)]
        .filter(Boolean)
        .join(" ") ||
      "Contacto";
    lines.push(formatted);
    const phones = Array.isArray(c.phones) ? c.phones : [];
    for (const p of phones) {
      const phone = asObj(p);
      const number = asStr(phone?.phone) || asStr(phone?.wa_id);
      if (number) {
        const kind = asStr(phone?.type);
        lines.push(kind ? `${kind}: ${number}` : number);
      }
    }
  }
  return lines.join("\n") || "Contacto compartido";
}

export function formatSystemMessage(raw: Json): string {
  const system = asObj(raw?.system);
  const type = asStr(system?.type);
  const waId = asStr(system?.wa_id);
  if (type === "user_changed_number" && waId) {
    return `El contacto cambió de número a +${waId.replace(/^\+/, "")}`;
  }
  return asStr(system?.body) || "Mensaje del sistema de WhatsApp";
}

export function formatUnsupportedMessage(): string {
  return "WhatsApp no compartió este mensaje (tipo no disponible para negocios).";
}

export function formatRevokedMessage(): string {
  return "Mensaje eliminado";
}

/** Body/type/media extracted from an edit.message object. */
export function extractEditedMessage(editMessage: unknown): {
  type: string;
  body: string;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSha256: string | null;
} {
  const msg = asObj(editMessage);
  const type = asStr(msg?.type) || "text";
  if (["image", "audio", "video", "document", "sticker"].includes(type)) {
    const media = asObj(msg?.[type]);
    const mediaUrl = asStr(media?.link);
    const mediaMime = asStr(media?.mime_type) || asStr(media?.mimeType);
    const mediaFilename = asStr(media?.filename);
    const mediaSha256 = asStr(media?.sha256);
    const caption = asStr(media?.caption);
    const body =
      caption ||
      mediaFilename ||
      (type === "audio"
        ? "Nota de voz"
        : type === "image"
          ? "Imagen"
          : type === "video"
            ? "Video"
            : type === "sticker"
              ? "Sticker"
              : "Documento");
    return { type, body, mediaUrl, mediaMime, mediaFilename, mediaSha256 };
  }
  const textBody = asStr(asObj(msg?.text)?.body) || asStr(msg?.caption) || "";
  return {
    type: "text",
    body: textBody || "Mensaje editado",
    mediaUrl: null,
    mediaMime: null,
    mediaFilename: null,
    mediaSha256: null,
  };
}

export function buildInboundBody(
  type: string,
  raw: Json,
): string {
  switch (type) {
    case "interactive":
      return formatInteractiveCta(raw);
    case "contacts":
      return formatContactsCard(raw);
    case "system":
      return formatSystemMessage(raw);
    case "unsupported":
      return formatUnsupportedMessage();
    case "revoke":
      return formatRevokedMessage();
    case "edit": {
      const edit = asObj(raw?.edit);
      return extractEditedMessage(edit?.message).body;
    }
    default: {
      const text = asStr(asObj(raw?.text)?.body) || asStr(raw?.caption);
      return text || `[${type}]`;
    }
  }
}

export function extractUrlFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(/https?:\/\/[^\s]+/i);
  return match?.[0] ?? null;
}

export function mediaContentDisposition(
  filename: string | null | undefined,
  type: string,
  asAttachment: boolean,
): string {
  const fallback =
    type === "image"
      ? "imagen.jpg"
      : type === "document"
        ? "documento.pdf"
        : type === "audio"
          ? "audio.ogg"
          : type === "video"
            ? "video.mp4"
            : "archivo";
  const safe = (filename?.trim() || fallback).replace(/"/g, "");
  const kind = asAttachment ? "attachment" : "inline";
  return `${kind}; filename="${safe}"`;
}

export function isSpecialNoticeType(type: string, body: string | null | undefined) {
  if (type === "system" || type === "unsupported") return true;
  if (body === formatRevokedMessage()) return true;
  return false;
}
