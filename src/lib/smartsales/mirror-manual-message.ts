const DEFAULT_SMARTSALES = "https://smartsalesagent-api-prod.azurewebsites.net";
const DEFAULT_TIMEOUT_MS = 8_000;

export type MirrorManualMessageInput = {
  phoneNumber: string;
  content: string;
};

export type MirrorManualMessageResult =
  | { ok: true; skipped: false; idConversation: number }
  | { ok: true; skipped: true; reason: "empty_input" | "no_conversation" }
  | {
      ok: false;
      reason:
        | "missing_token"
        | "lookup_failed"
        | "create_failed"
        | "request_failed";
    };

export type MirrorManualMessageDeps = {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  baseUrl?: string;
  token?: string | null;
};

/** E.164 with a leading plus. SmartSales 404s when the plus is missing. */
export function toSmartSalesPhone(phone: string): string {
  let value = phone.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

/**
 * Copy a manually typed chat message into SmartSales.
 * Never throws: lookup misses and upstream failures resolve as a result.
 */
export async function mirrorManualMessage(
  input: MirrorManualMessageInput,
  deps: MirrorManualMessageDeps = {},
): Promise<MirrorManualMessageResult> {
  const content = input.content.trim();
  const phoneNumber = toSmartSalesPhone(input.phoneNumber);
  if (!content || !phoneNumber) {
    return { ok: true, skipped: true, reason: "empty_input" };
  }

  const token = (
    deps.token !== undefined ? deps.token : process.env.SMARTSALES_API_TOKEN
  )?.trim();
  if (!token) return { ok: false, reason: "missing_token" };

  const base = (
    deps.baseUrl ??
    process.env.SMARTSALES_API_BASE_URL ??
    DEFAULT_SMARTSALES
  )
    .trim()
    .replace(/\/$/, "");

  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const lookupUrl = `${base}/Conversations/GetLastByPhoneNumber?phoneNumber=${encodeURIComponent(phoneNumber)}`;
    const lookupRes = await fetchImpl(lookupUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal,
    });
    const lookup = await readJson(lookupRes);
    if (!lookupRes.ok && lookupRes.status !== 404) {
      return { ok: false, reason: "lookup_failed" };
    }

    const record = asRecord(lookup.data);
    const idConversation = record?.idConversation;
    if (
      lookupRes.status === 404 ||
      lookup.err === true ||
      record == null ||
      typeof idConversation !== "number" ||
      !Number.isFinite(idConversation) ||
      idConversation <= 0
    ) {
      return { ok: true, skipped: true, reason: "no_conversation" };
    }

    const idBot = typeof record.idBot === "string" ? record.idBot : null;
    const createRes = await fetchImpl(`${base}/Conversations/CreateMessage`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        idConversation,
        message: [
          {
            idBot,
            sender: "assistant",
            timestamp: now().toISOString(),
            content,
            urlMedia: null,
          },
        ],
      }),
      cache: "no-store",
      signal,
    });
    const created = await readJson(createRes);
    if (!createRes.ok || created.err === true) {
      return { ok: false, reason: "create_failed" };
    }
    return { ok: true, skipped: false, idConversation };
  } catch {
    return { ok: false, reason: "request_failed" };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data = (await response.json()) as unknown;
    return asRecord(data) ?? {};
  } catch {
    return {};
  }
}
