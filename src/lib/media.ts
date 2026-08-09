/** WhatsApp / Meta media limits (practical UI caps where noted). */
export const MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 10 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 15 * 1024 * 1024,
  sticker: 100 * 1024,
  inboundDocument: 100 * 1024 * 1024,
} as const;

export const OUTBOUND_IMAGE_MIMES = ["image/jpeg", "image/png"] as const;
export const OUTBOUND_AUDIO_MIMES = [
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
] as const;
export const OUTBOUND_DOCUMENT_MIMES = ["application/pdf"] as const;

export type MediaKind = "image" | "audio" | "video" | "document" | "sticker";

export function mediaKindFromMime(mime: string): MediaKind | null {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  if (m.startsWith("image/webp")) return "sticker";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (
    m === "application/pdf" ||
    m.startsWith("application/msword") ||
    m.startsWith("application/vnd.") ||
    m === "text/plain"
  ) {
    return "document";
  }
  return null;
}

export function maxBytesForKind(kind: MediaKind, inbound = false): number {
  if (kind === "document" && inbound) return MEDIA_LIMITS.inboundDocument;
  return MEDIA_LIMITS[kind];
}

export function validateOutboundFile(file: {
  type: string;
  size: number;
  name?: string;
}): { ok: true; kind: MediaKind } | { ok: false; error: string } {
  const mime = file.type.toLowerCase().split(";")[0]!.trim();
  let kind: MediaKind | null = null;

  if ((OUTBOUND_IMAGE_MIMES as readonly string[]).includes(mime)) kind = "image";
  else if ((OUTBOUND_AUDIO_MIMES as readonly string[]).includes(mime)) {
    kind = "audio";
  } else if (mime.startsWith("audio/webm") || mime === "video/webm") {
    return {
      ok: false,
      error:
        "WhatsApp no acepta audio/webm. Graba la nota de voz desde el micrófono del chat.",
    };
  } else if ((OUTBOUND_DOCUMENT_MIMES as readonly string[]).includes(mime)) {
    kind = "document";
  }

  if (!kind) {
    return {
      ok: false,
      error: `Tipo no permitido: ${mime || "desconocido"}. Usa JPG/PNG, audio o PDF.`,
    };
  }

  const max = maxBytesForKind(kind);
  if (file.size > max) {
    return {
      ok: false,
      error: `Archivo demasiado grande (${Math.round(file.size / 1024 / 1024)}MB). Máximo ${Math.round(max / 1024 / 1024)}MB.`,
    };
  }

  return { ok: true, kind };
}

export function extractInboundMedia(msg: Record<string, unknown>): {
  type: MediaKind | "text";
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSha256: string | null;
} | null {
  const type = String(msg.type ?? "text");
  const mediaTypes = ["image", "audio", "video", "document", "sticker"] as const;
  if (!(mediaTypes as readonly string[]).includes(type)) return null;

  const block = msg[type] as Record<string, unknown> | undefined;
  if (!block || typeof block !== "object") {
    return {
      type: type as MediaKind,
      body: `[${type}]`,
      mediaUrl: null,
      mediaMime: null,
      mediaFilename: null,
      mediaSha256: null,
    };
  }

  const caption = typeof block.caption === "string" ? block.caption : null;
  const filename =
    typeof block.filename === "string" ? block.filename : null;
  const link = typeof block.link === "string" ? block.link : null;
  const mime =
    typeof block.mime_type === "string"
      ? block.mime_type
      : typeof block.mimeType === "string"
        ? block.mimeType
        : null;
  const sha =
    typeof block.sha256 === "string" ? block.sha256 : null;

  const body =
    caption ||
    filename ||
    (type === "audio"
      ? "Nota de voz"
      : type === "image"
        ? "Imagen"
        : type === "video"
          ? "Video"
          : type === "sticker"
            ? "Sticker"
            : type === "document"
              ? "Documento"
              : `[${type}]`);

  return {
    type: type as MediaKind,
    body,
    mediaUrl: link,
    mediaMime: mime,
    mediaFilename: filename,
    mediaSha256: sha,
  };
}
