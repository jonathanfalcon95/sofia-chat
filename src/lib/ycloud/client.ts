const YCLOUD_BASE = "https://api.ycloud.com/v2";

function apiKey() {
  const key = process.env.YCLOUD_API_KEY;
  if (!key) throw new Error("YCLOUD_API_KEY no configurada");
  return key;
}

async function ycloudFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${YCLOUD_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey(),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const message =
      typeof data === "object" && data && "message" in data
        ? String((data as { message: string }).message)
        : text || res.statusText;
    throw new Error(`YCloud ${res.status}: ${message}`);
  }

  return data as T;
}

export type SendTextParams = {
  from: string;
  to: string;
  text: string;
  /** WhatsApp wamid of the message being replied to. */
  replyToWamid?: string;
};

export type SendTemplateParams = {
  from: string;
  to: string;
  template: {
    name: string;
    language: { code: string };
    components?: unknown[];
  };
};

export async function sendWhatsAppText(params: SendTextParams) {
  const payload: Record<string, unknown> = {
    from: params.from,
    to: params.to,
    type: "text",
    text: { body: params.text },
  };
  if (params.replyToWamid) {
    payload.context = { message_id: params.replyToWamid };
  }
  return ycloudFetch<Record<string, unknown>>("/whatsapp/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function sendWhatsAppTemplate(params: SendTemplateParams) {
  return ycloudFetch<Record<string, unknown>>("/whatsapp/messages", {
    method: "POST",
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      type: "template",
      template: params.template,
    }),
  });
}

export async function uploadWhatsAppMedia(params: {
  phoneNumber: string;
  file: Blob;
  filename: string;
  mimeType: string;
}) {
  const phone = encodeURIComponent(params.phoneNumber);
  const form = new FormData();
  form.append(
    "file",
    params.file,
    params.filename || `upload.${params.mimeType.split("/")[1] || "bin"}`,
  );

  const res = await fetch(`${YCLOUD_BASE}/whatsapp/media/${phone}/upload`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey(),
    },
    body: form,
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const message =
      typeof data === "object" && data && "message" in data
        ? String((data as { message: string }).message)
        : text || res.statusText;
    throw new Error(`YCloud upload ${res.status}: ${message}`);
  }

  const id =
    typeof data === "object" && data && "id" in data
      ? String((data as { id: string }).id)
      : null;
  if (!id) throw new Error("YCloud upload: missing media id");
  return { id, raw: data as Record<string, unknown> };
}

export async function sendWhatsAppMedia(params: {
  from: string;
  to: string;
  type: "image" | "audio" | "document";
  mediaId: string;
  caption?: string;
  filename?: string;
  replyToWamid?: string;
}) {
  const mediaBody: Record<string, unknown> = { id: params.mediaId };
  if (params.caption && params.type !== "audio") {
    mediaBody.caption = params.caption;
  }
  if (params.type === "document" && params.filename) {
    mediaBody.filename = params.filename;
  }

  const payload: Record<string, unknown> = {
    from: params.from,
    to: params.to,
    type: params.type,
    [params.type]: mediaBody,
  };
  if (params.replyToWamid) {
    payload.context = { message_id: params.replyToWamid };
  }

  return ycloudFetch<Record<string, unknown>>("/whatsapp/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function sendWhatsAppReaction(params: {
  from: string;
  to: string;
  messageId: string;
  emoji: string;
}) {
  return ycloudFetch<Record<string, unknown>>("/whatsapp/messages/sendDirectly", {
    method: "POST",
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      type: "reaction",
      reaction: {
        message_id: params.messageId,
        emoji: params.emoji,
      },
    }),
  });
}

export async function downloadYCloudMedia(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, {
      headers: { "X-API-Key": apiKey() },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listWhatsAppTemplates(params?: {
  page?: number;
  limit?: number;
  wabaId?: string;
}) {
  const search = new URLSearchParams();
  if (params?.page) search.set("page", String(params.page));
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.wabaId) search.set("filter.wabaId", params.wabaId);
  const qs = search.toString();
  return ycloudFetch<{ items?: unknown[]; data?: unknown[] }>(
    `/whatsapp/templates${qs ? `?${qs}` : ""}`,
  );
}

export type YCloudPhoneNumber = {
  id: string;
  phoneNumber?: string;
  displayPhoneNumber?: string;
  wabaId?: string;
  verifiedName?: string;
  newName?: string;
  status?: string;
};

export type YCloudPhoneNumberPage = {
  items?: YCloudPhoneNumber[];
  data?: YCloudPhoneNumber[];
  offset?: number;
  limit?: number;
  length?: number;
  total?: number;
};

export async function listWhatsAppPhoneNumbers(params?: {
  page?: number;
  limit?: number;
  includeTotal?: boolean;
  wabaId?: string;
}) {
  const search = new URLSearchParams();
  if (params?.page) search.set("page", String(params.page));
  if (params?.limit) search.set("limit", String(params.limit));
  if (params?.includeTotal) search.set("includeTotal", "true");
  if (params?.wabaId) search.set("filter.wabaId", params.wabaId);
  const qs = search.toString();
  return ycloudFetch<YCloudPhoneNumberPage>(
    `/whatsapp/phoneNumbers${qs ? `?${qs}` : ""}`,
  );
}
