/**
 * Fills messages.rich_content (header and buttons) and the text of placeholder messages
 * (templates, button replies) for recent template, interactive and button messages.
 * Simulates by default: reads SQL Server and YCloud, writes nothing.
 *
 *   npx tsx scripts/backfill-rich-content.ts [--days=60]
 *   npx tsx scripts/backfill-rich-content.ts --apply
 *
 * Needs DATA_BACKEND=sqlserver and the app's SQL_* and YCloud settings in the environment.
 * The report has counts only: no message text, names or phone numbers.
 */
import { getSystemDb } from "../src/lib/db/client";
import { systemSqlDb } from "../src/lib/db/sqlserver/db";
import { sql } from "../src/lib/db/sqlserver/sql";
import {
  applyResolvedText,
  resolveMessageText,
  type EnrichableMessage,
} from "../src/lib/ycloud/message-enrichment";
import { richFromMessage } from "../src/lib/ycloud/rich-content";

const PAGE_SIZE = 500;
const DELAY_AFTER_TEMPLATE_MS = 200;

function argValue(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

type Candidate = EnrichableMessage & {
  raw_payload: unknown;
  has_rich: number;
};

async function main() {
  if (process.env.DATA_BACKEND !== "sqlserver") {
    throw new Error("DATA_BACKEND debe ser sqlserver");
  }
  const apply = process.argv.includes("--apply");
  const days = Number(argValue("days") ?? 60);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days entre 1 y 365");
  console.log(`Modo: ${apply ? "APLICAR" : "simulación (no escribe nada)"} · últimos ${days} días`);

  const db = getSystemDb();
  const raw = systemSqlDb();
  const report = new Map<string, number>();
  const count = (key: string) => report.set(key, (report.get(key) ?? 0) + 1);

  let afterCreated = "1900-01-01T00:00:00.000Z";
  let afterId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = (await raw.run(sql`
      SELECT TOP (${PAGE_SIZE}) m.id, m.type, m.body, m.conversation_id, m.created_at, m.raw_payload,
             CASE WHEN m.rich_content IS NULL THEN 0 ELSE 1 END AS has_rich
      FROM chatbase.messages m
      WHERE m.type IN (N'template', N'interactive', N'button')
        AND m.raw_payload IS NOT NULL
        AND m.created_at >= DATEADD(day, ${-days}, SYSUTCDATETIME())
        AND (m.created_at > ${afterCreated} OR (m.created_at = ${afterCreated} AND m.id > ${afterId}))
      ORDER BY m.created_at, m.id`)) as unknown as Candidate[];
    if (rows.length === 0) break;
    const last = rows[rows.length - 1];
    afterCreated = new Date(last.created_at).toISOString();
    afterId = last.id;

    for (const row of rows) {
      const message =
        row.raw_payload && typeof row.raw_payload === "object"
          ? (row.raw_payload as Record<string, unknown>)
          : {};
      const created_at = new Date(row.created_at).toISOString();
      const candidate = { ...row, created_at };

      // Placeholder text, and for templates the buttons, which need the definition.
      const resolved = await resolveMessageText(db, candidate, message);
      if (resolved) {
        count(`${row.type} · texto ${resolved.source}`);
        if (resolved.body.includes("{{")) count(`${row.type} · con variables sin valor`);
        if (apply) await applyResolvedText(db, candidate, resolved);
        if (row.type === "template") {
          await new Promise((r) => setTimeout(r, DELAY_AFTER_TEMPLATE_MS));
        }
      }
      if (resolved?.rich) continue;

      if (row.has_rich) {
        count(`${row.type} · ya tenía botones`);
        continue;
      }
      const rich = richFromMessage(message);
      if (!rich) {
        count(`${row.type} · sin botones ni encabezado`);
        continue;
      }
      count(`${row.type} · botones nuevos`);
      if (apply) {
        await raw.run(sql`UPDATE chatbase.messages SET rich_content = ${JSON.stringify(rich)}
                          WHERE id = ${row.id} AND rich_content IS NULL`);
      }
    }
  }

  console.log("\nResultado:");
  for (const [key, value] of [...report].sort()) console.log(`  ${key}: ${value}`);
  if (!apply) console.log("\nNo se escribió nada.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
