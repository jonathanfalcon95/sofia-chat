import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret, secretLast4 } from "@/lib/crypto/secret";
import {
  YCLOUD_WHATSAPP_WEBHOOK_EVENTS,
  createWebhookEndpoint,
  listWebhookEndpoints,
  listWhatsAppPhoneNumbers,
  updateWebhookEndpoint,
  type YCloudPhoneNumber,
} from "@/lib/ycloud/client";

import type { YCloudAccountPublic } from "@/lib/ycloud/types";

export type { YCloudAccountPublic } from "@/lib/ycloud/types";

export type YCloudAccountRow = {
  id: string;
  name: string;
  api_key_encrypted: string;
  webhook_secret_encrypted: string | null;
  ycloud_webhook_endpoint_id: string | null;
  api_key_last4: string | null;
  is_active: boolean;
};

export type InboxYCloudCredentials = {
  accountId: string;
  apiKey: string;
  webhookSecret: string | null;
  phoneNumber: string;
  wabaId: string | null;
};

function appBaseUrl() {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://chatbase-beryl.vercel.app");
  return raw.replace(/\/$/, "");
}

export function ycloudWebhookPublicUrl(accountId: string) {
  return `${appBaseUrl()}/api/webhooks/ycloud/${accountId}`;
}

function isOurWebhookUrl(url: string | undefined) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.includes("/api/webhooks/ycloud");
  } catch {
    return url.includes("/api/webhooks/ycloud");
  }
}

function toPublic(row: YCloudAccountRow): YCloudAccountPublic {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    apiKeyLast4: row.api_key_last4,
    webhookEndpointId: row.ycloud_webhook_endpoint_id,
    webhookUrl: ycloudWebhookPublicUrl(row.id),
    hasWebhookSecret: Boolean(row.webhook_secret_encrypted),
  };
}

export async function listYCloudAccountRows() {
  const db = createAdminClient();
  const { data, error } = await db
    .from("ycloud_accounts")
    .select(
      "id, name, api_key_encrypted, webhook_secret_encrypted, ycloud_webhook_endpoint_id, api_key_last4, is_active",
    )
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as YCloudAccountRow[];
}

export async function listYCloudAccountsPublic(): Promise<YCloudAccountPublic[]> {
  const rows = await listYCloudAccountRows();
  return rows.map(toPublic);
}

export function decryptAccountApiKey(row: YCloudAccountRow): string {
  try {
    return decryptSecret(row.api_key_encrypted);
  } catch {
    const fallback = process.env.YCLOUD_API_KEY?.trim();
    if (fallback && (!row.api_key_last4 || fallback.endsWith(row.api_key_last4))) {
      return fallback;
    }
    const second = process.env.YCLOUD_ACCOUNT_2_API_KEY?.trim();
    if (second && (!row.api_key_last4 || second.endsWith(row.api_key_last4))) {
      return second;
    }
    throw new Error(`No se pudo descifrar la API key de ${row.name}`);
  }
}

export function decryptAccountWebhookSecret(row: YCloudAccountRow): string | null {
  if (!row.webhook_secret_encrypted) {
    const env1 = process.env.YCLOUD_WEBHOOK_SECRET?.trim();
    if (env1 && row.name.toLowerCase().includes("1")) return env1;
    const env2 = process.env.YCLOUD_ACCOUNT_2_WEBHOOK_SECRET?.trim();
    if (env2 && row.name.toLowerCase().includes("2")) return env2;
    return env1 || env2 || null;
  }
  try {
    return decryptSecret(row.webhook_secret_encrypted);
  } catch {
    return (
      process.env.YCLOUD_WEBHOOK_SECRET?.trim() ||
      process.env.YCLOUD_ACCOUNT_2_WEBHOOK_SECRET?.trim() ||
      null
    );
  }
}

export async function getYCloudAccountCredentials(accountId: string) {
  const db = createAdminClient();
  const { data, error } = await db
    .from("ycloud_accounts")
    .select(
      "id, name, api_key_encrypted, webhook_secret_encrypted, ycloud_webhook_endpoint_id, api_key_last4, is_active",
    )
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Cuenta YCloud no encontrada");
  const row = data as YCloudAccountRow;
  if (!row.is_active) throw new Error("La cuenta YCloud está inactiva");
  return {
    row,
    apiKey: decryptAccountApiKey(row),
    webhookSecret: decryptAccountWebhookSecret(row),
  };
}

export async function getInboxYCloudCredentials(
  inboxId: string,
): Promise<InboxYCloudCredentials> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("inboxes")
    .select("id, phone_number, waba_id, ycloud_account_id")
    .eq("id", inboxId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.phone_number) throw new Error("Inbox no encontrado");

  if (data.ycloud_account_id) {
    const creds = await getYCloudAccountCredentials(data.ycloud_account_id as string);
    return {
      accountId: creds.row.id,
      apiKey: creds.apiKey,
      webhookSecret: creds.webhookSecret,
      phoneNumber: data.phone_number as string,
      wabaId: (data.waba_id as string | null) ?? null,
    };
  }

  const envKey = process.env.YCLOUD_API_KEY?.trim();
  if (!envKey) {
    throw new Error("El inbox no tiene cuenta YCloud asociada");
  }
  return {
    accountId: "",
    apiKey: envKey,
    webhookSecret: process.env.YCLOUD_WEBHOOK_SECRET?.trim() || null,
    phoneNumber: data.phone_number as string,
    wabaId: (data.waba_id as string | null) ?? null,
  };
}

export async function upsertYCloudAccount(input: {
  id?: string;
  name: string;
  apiKey?: string;
  webhookSecret?: string;
  isActive?: boolean;
}) {
  const db = createAdminClient();
  const name = input.name.trim();
  if (!name) throw new Error("El nombre es obligatorio");

  if (input.id) {
    const patch: Record<string, unknown> = {
      name,
      is_active: input.isActive ?? true,
      updated_at: new Date().toISOString(),
    };
    if (input.apiKey?.trim()) {
      patch.api_key_encrypted = encryptSecret(input.apiKey.trim());
      patch.api_key_last4 = secretLast4(input.apiKey.trim());
    }
    if (input.webhookSecret?.trim()) {
      patch.webhook_secret_encrypted = encryptSecret(input.webhookSecret.trim());
    }
    const { data, error } = await db
      .from("ycloud_accounts")
      .update(patch)
      .eq("id", input.id)
      .select(
        "id, name, api_key_encrypted, webhook_secret_encrypted, ycloud_webhook_endpoint_id, api_key_last4, is_active",
      )
      .single();
    if (error || !data) throw new Error(error?.message ?? "update_failed");
    return data as YCloudAccountRow;
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new Error("La API key es obligatoria");
  const { data, error } = await db
    .from("ycloud_accounts")
    .insert({
      name,
      api_key_encrypted: encryptSecret(apiKey),
      api_key_last4: secretLast4(apiKey),
      webhook_secret_encrypted: input.webhookSecret?.trim()
        ? encryptSecret(input.webhookSecret.trim())
        : null,
      is_active: input.isActive ?? true,
    })
    .select(
      "id, name, api_key_encrypted, webhook_secret_encrypted, ycloud_webhook_endpoint_id, api_key_last4, is_active",
    )
    .single();
  if (error || !data) throw new Error(error?.message ?? "create_failed");
  return data as YCloudAccountRow;
}

export async function ensureYCloudWebhook(accountId: string) {
  const creds = await getYCloudAccountCredentials(accountId);
  const targetUrl = ycloudWebhookPublicUrl(accountId);
  const endpoints = await listWebhookEndpoints(creds.apiKey);
  const ours = endpoints.filter((ep) => isOurWebhookUrl(ep.url));
  const exact = ours.find((ep) => ep.url === targetUrl);
  const stored = ours.find(
    (ep) => ep.id === creds.row.ycloud_webhook_endpoint_id,
  );
  const legacy = ours.find((ep) =>
    (ep.url || "").replace(/\/$/, "").endsWith("/api/webhooks/ycloud"),
  );
  const existing = exact || stored || legacy || ours[0];

  let endpoint = existing;
  if (existing) {
    const needsPatch =
      existing.url !== targetUrl ||
      existing.status !== "active" ||
      YCLOUD_WHATSAPP_WEBHOOK_EVENTS.some(
        (evt) => !(existing.enabledEvents ?? []).includes(evt),
      );
    if (needsPatch) {
      endpoint = await updateWebhookEndpoint(creds.apiKey, existing.id, {
        url: targetUrl,
        enabledEvents: [...YCLOUD_WHATSAPP_WEBHOOK_EVENTS],
        status: "active",
        description: `Sofia Chat · ${creds.row.name}`,
      });
    }
  } else {
    endpoint = await createWebhookEndpoint(creds.apiKey, {
      url: targetUrl,
      enabledEvents: [...YCLOUD_WHATSAPP_WEBHOOK_EVENTS],
      status: "active",
      description: `Sofia Chat · ${creds.row.name}`,
    });
  }

  const secret = endpoint.secret?.trim() || creds.webhookSecret;
  const db = createAdminClient();
  const { error } = await db
    .from("ycloud_accounts")
    .update({
      ycloud_webhook_endpoint_id: endpoint.id,
      webhook_secret_encrypted: secret ? encryptSecret(secret) : creds.row.webhook_secret_encrypted,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId);
  if (error) throw new Error(error.message);

  return {
    endpointId: endpoint.id,
    url: targetUrl,
    created: !existing,
    updated: Boolean(existing),
  };
}

function envAccountSpecs() {
  const specs: Array<{
    name: string;
    apiKey?: string;
    webhookSecret?: string;
  }> = [];
  const key1 = process.env.YCLOUD_API_KEY?.trim();
  if (key1) {
    specs.push({
      name: "YCloud 1",
      apiKey: key1,
      webhookSecret: process.env.YCLOUD_WEBHOOK_SECRET?.trim(),
    });
  }
  const key2 = process.env.YCLOUD_ACCOUNT_2_API_KEY?.trim();
  if (key2) {
    specs.push({
      name: "YCloud 2",
      apiKey: key2,
      webhookSecret: process.env.YCLOUD_ACCOUNT_2_WEBHOOK_SECRET?.trim(),
    });
  }
  return specs;
}

export async function seedYCloudAccountsFromEnv() {
  const db = createAdminClient();
  const existing = await listYCloudAccountRows();
  const created: YCloudAccountRow[] = [...existing];

  for (const spec of envAccountSpecs()) {
    if (!spec.apiKey) continue;
    const last4 = secretLast4(spec.apiKey);
    const already = created.find(
      (row) =>
        row.api_key_last4 === last4 ||
        row.name.toLowerCase() === spec.name.toLowerCase(),
    );
    if (already) continue;
    const row = await upsertYCloudAccount({
      name: spec.name,
      apiKey: spec.apiKey,
      webhookSecret: spec.webhookSecret,
    });
    created.push(row);
  }

  const account1 = created.find((r) => r.name === "YCloud 1") ?? created[0];
  if (account1) {
    const { error } = await db
      .from("inboxes")
      .update({ ycloud_account_id: account1.id })
      .is("ycloud_account_id", null);
    if (error) throw new Error(error.message);
  }

  return created.map(toPublic);
}

function normalizeE164(phone: string) {
  const trimmed = phone.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

export function ycloudLegacyWebhookPublicUrl() {
  return `${appBaseUrl()}/api/webhooks/ycloud`;
}

export async function restoreLegacyYCloudWebhook(accountId: string) {
  const creds = await getYCloudAccountCredentials(accountId);
  const endpointId = creds.row.ycloud_webhook_endpoint_id;
  if (!endpointId) throw new Error("La cuenta no tiene webhook endpoint");
  await updateWebhookEndpoint(creds.apiKey, endpointId, {
    url: ycloudLegacyWebhookPublicUrl(),
    enabledEvents: [...YCLOUD_WHATSAPP_WEBHOOK_EVENTS],
    status: "active",
    description: `Sofia Chat · ${creds.row.name} (legacy)`,
  });
  return { endpointId, url: ycloudLegacyWebhookPublicUrl() };
}

export async function syncYCloudPhoneNumbers(accountId: string) {
  const db = createAdminClient();
  const creds = await getYCloudAccountCredentials(accountId);

  const remote: YCloudPhoneNumber[] = [];
  let page = 1;
  for (;;) {
    const res = await listWhatsAppPhoneNumbers({
      apiKey: creds.apiKey,
      page,
      limit: 100,
      includeTotal: true,
    });
    const items = res.items ?? res.data ?? [];
    remote.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 50) break;
  }

  const { data: existing, error: existingError } = await db
    .from("inboxes")
    .select(
      "id, phone_number, ycloud_phone_number_id, name, waba_id, ycloud_account_id",
    );
  if (existingError) throw new Error(existingError.message);

  type InboxRow = NonNullable<typeof existing>[number];
  const byYCloudId = new Map<string, InboxRow>();
  const byPhone = new Map<string, InboxRow>();
  for (const row of existing ?? []) {
    if (row.ycloud_phone_number_id && row.ycloud_account_id === accountId) {
      byYCloudId.set(row.ycloud_phone_number_id, row);
    }
    byPhone.set(normalizeE164(row.phone_number), row);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of remote) {
    const ycloudId = item.id?.trim();
    const rawPhone = item.phoneNumber || item.displayPhoneNumber || "";
    const phone = normalizeE164(rawPhone.replace(/[^\d+]/g, ""));
    if (!ycloudId || !phone) continue;

    const name =
      item.verifiedName?.trim() ||
      item.newName?.trim() ||
      item.displayPhoneNumber?.trim() ||
      phone;
    const wabaId = item.wabaId?.trim() || null;

    const matchById = byYCloudId.get(ycloudId) ?? null;
    const matchByPhone = byPhone.get(phone) ?? null;
    if (
      matchByPhone?.ycloud_account_id &&
      matchByPhone.ycloud_account_id !== accountId &&
      matchByPhone.ycloud_phone_number_id !== ycloudId
    ) {
      skipped += 1;
      continue;
    }
    const match = matchById ?? matchByPhone ?? null;

    if (!match) {
      const { data: inserted, error } = await db
        .from("inboxes")
        .insert({
          company_id: null,
          name,
          phone_number: phone,
          ycloud_phone_number_id: ycloudId,
          waba_id: wabaId,
          ycloud_account_id: accountId,
          is_active: true,
        })
        .select(
          "id, phone_number, ycloud_phone_number_id, name, waba_id, ycloud_account_id",
        )
        .single();
      if (error) throw new Error(error.message);
      if (inserted) {
        byYCloudId.set(ycloudId, inserted);
        byPhone.set(phone, inserted);
      }
      created += 1;
      continue;
    }

    const { error } = await db
      .from("inboxes")
      .update({
        name,
        phone_number: phone,
        ycloud_phone_number_id: ycloudId,
        waba_id: wabaId,
        ycloud_account_id: accountId,
      })
      .eq("id", match.id);
    if (error) throw new Error(error.message);
    updated += 1;
    const next = {
      ...match,
      name,
      phone_number: phone,
      ycloud_phone_number_id: ycloudId,
      waba_id: wabaId,
      ycloud_account_id: accountId,
    };
    byYCloudId.set(ycloudId, next);
    byPhone.set(phone, next);
  }

  return { created, updated, skipped, total: remote.length };
}
