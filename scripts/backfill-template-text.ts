/**
 * Recovers the text of stored placeholder messages (templates, button replies).
 * Simulates by default: reads YCloud and Supabase, writes nothing.
 *
 *   npx tsx scripts/backfill-template-text.ts [--env=path/to/.env.local]
 *   npx tsx scripts/backfill-template-text.ts --apply --expect-host=<supabase host>
 *
 * The report has counts only: no message text, names or phone numbers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  applyResolvedText,
  ENRICHABLE_MESSAGE_SELECT,
  resolveMessageText,
  type EnrichableMessage,
} from "../src/lib/ycloud/message-enrichment";

const PAGE_LIMIT = 1000;
const DELAY_BETWEEN_MESSAGES_MS = 200;

const CANDIDATE_FILTER = [
  'and(type.eq.template,body.eq."[template]")',
  'and(type.eq.template,body.like."Plantilla:*")',
  'and(type.eq.button,body.eq."[button]")',
  'and(type.eq.interactive,body.eq."[interactive]")',
  'and(type.eq.interactive,body.eq."Mensaje interactivo")',
].join(",");

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function loadEnvFile(path: string) {
  const text = readFileSync(resolve(process.cwd(), path), "utf8");
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

async function main() {
  loadEnvFile(argValue("env") ?? ".env.local");

  const apply = process.argv.includes("--apply");
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  console.log(`Proyecto: ${host}`);
  console.log(`Modo: ${apply ? "APLICAR" : "simulación (no escribe nada)"}`);
  if (apply && argValue("expect-host") !== host) {
    throw new Error(`--apply requiere --expect-host=${host}`);
  }

  const db = createAdminClient();
  const { data: companies, error: companiesError } = await db
    .from("companies")
    .select("id, name");
  if (companiesError) throw new Error(companiesError.message);
  const companyNames = new Map(
    (companies ?? []).map((c) => [c.id as string, c.name as string]),
  );

  const { data, error } = await db
    .from("messages")
    .select(`${ENRICHABLE_MESSAGE_SELECT}, company_id, raw_payload`)
    .or(CANDIDATE_FILTER)
    .order("created_at")
    .limit(PAGE_LIMIT);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<
    EnrichableMessage & { company_id: string; raw_payload: unknown }
  >;
  console.log(`Candidatos: ${rows.length}`);
  if (rows.length === PAGE_LIMIT) {
    console.log(`Hay más de ${PAGE_LIMIT}: vuelve a ejecutar al terminar.`);
  }

  const report = new Map<string, number>();
  const count = (company: string, outcome: string) => {
    const key = `${company} · ${outcome}`;
    report.set(key, (report.get(key) ?? 0) + 1);
  };

  for (const row of rows) {
    const company = companyNames.get(row.company_id) ?? row.company_id;
    const message =
      row.raw_payload && typeof row.raw_payload === "object"
        ? (row.raw_payload as Record<string, unknown>)
        : {};
    const resolved = await resolveMessageText(db, row, message);
    if (!resolved) {
      count(company, "sin datos para recuperar");
    } else {
      count(company, resolved.source);
      if (resolved.body.includes("{{")) count(company, "con variables sin valor");
      if (apply) await applyResolvedText(db, row, resolved);
    }
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_MESSAGES_MS));
  }

  console.log("\nResultado:");
  for (const [key, value] of [...report].sort()) {
    console.log(`  ${key}: ${value}`);
  }
  if (!apply) console.log("\nNo se escribió nada.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
