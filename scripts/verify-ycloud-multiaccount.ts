import { encryptSecret, decryptSecret } from "../src/lib/crypto/secret";
import {
  ensureYCloudWebhook,
  listYCloudAccountsPublic,
  seedYCloudAccountsFromEnv,
} from "../src/lib/ycloud/accounts";
import {
  listWebhookEndpoints,
  listWhatsAppPhoneNumbers,
} from "../src/lib/ycloud/client";

function loadEnvLocal() {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  const path = resolve(process.cwd(), ".env.local");
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

async function countPhones(apiKey: string) {
  const res = await listWhatsAppPhoneNumbers({
    apiKey,
    page: 1,
    limit: 100,
    includeTotal: true,
  });
  const items = res.items ?? res.data ?? [];
  return { count: items.length, sample: items.slice(0, 3).map((i) => i.displayPhoneNumber || i.phoneNumber || i.id) };
}

async function main() {
  loadEnvLocal();
  const failures: string[] = [];

  try {
    const plain = "whsec_test_roundtrip_value";
    const enc = encryptSecret(plain);
    const dec = decryptSecret(enc);
    assert(dec === plain, "encrypt/decrypt roundtrip failed");
    assert(enc.startsWith("v1:"), "encrypted payload missing v1 prefix");
    console.log("OK  cifrado AES-256-GCM");
  } catch (err) {
    failures.push(`cifrado: ${err instanceof Error ? err.message : err}`);
    console.error("FAIL cifrado", err);
  }

  const key1 = process.env.YCLOUD_API_KEY?.trim();
  const key2 = process.env.YCLOUD_ACCOUNT_2_API_KEY?.trim();
  assert(key1, "YCLOUD_API_KEY missing");
  assert(key2, "YCLOUD_ACCOUNT_2_API_KEY missing");
  assert(key1 !== key2, "account 1 and 2 API keys are identical");

  try {
    const a1 = await countPhones(key1!);
    console.log(`OK  YCloud 1 phoneNumbers: ${a1.count}`, a1.sample);
  } catch (err) {
    failures.push(`ycloud1 phones: ${err instanceof Error ? err.message : err}`);
    console.error("FAIL YCloud 1 phoneNumbers", err);
  }

  try {
    const a2 = await countPhones(key2!);
    console.log(`OK  YCloud 2 phoneNumbers: ${a2.count}`, a2.sample);
  } catch (err) {
    failures.push(`ycloud2 phones: ${err instanceof Error ? err.message : err}`);
    console.error("FAIL YCloud 2 phoneNumbers", err);
  }

  try {
    const seeded = await seedYCloudAccountsFromEnv();
    console.log(
      "OK  seed cuentas",
      seeded.map((a) => `${a.name} …${a.apiKeyLast4}`),
    );
  } catch (err) {
    failures.push(`seed: ${err instanceof Error ? err.message : err}`);
    console.error("FAIL seed", err);
  }

  const accounts = await listYCloudAccountsPublic().catch(() => []);
  for (const account of accounts) {
    try {
      const credsKey =
        account.name === "YCloud 2" ? key2! : key1!;
      const hooks = await listWebhookEndpoints(credsKey);
      console.log(
        `OK  ${account.name} webhooks existentes:`,
        hooks.map((h) => `${h.id} ${h.url} ${h.status}`),
      );
      const result = await ensureYCloudWebhook(account.id);
      console.log(`OK  ${account.name} ensureWebhook`, result);
    } catch (err) {
      failures.push(
        `webhook ${account.name}: ${err instanceof Error ? err.message : err}`,
      );
      console.error(`FAIL webhook ${account.name}`, err);
    }
  }

  if (failures.length) {
    console.error("\nRESULTADO: FAIL");
    for (const f of failures) console.error("-", f);
    process.exit(1);
  }
  console.log("\nRESULTADO: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
