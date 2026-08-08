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
  return ycloudFetch<Record<string, unknown>>("/whatsapp/messages", {
    method: "POST",
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      type: "text",
      text: { body: params.text },
    }),
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

export async function listWhatsAppPhoneNumbers() {
  return ycloudFetch<{ items?: unknown[]; data?: unknown[] }>(
    "/whatsapp/phoneNumbers",
  );
}
