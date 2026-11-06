import { execute } from "@/lib/db/sqlserver/connection";
import { sql } from "@/lib/db/sqlserver/sql";

/**
 * While the database changes, verified webhooks are stored as they arrived and processed later in
 * order. An App Setting, so it stays on across the restarts the switch itself causes.
 */
export function isWebhookCaptureOn() {
  return process.env.WEBHOOK_CAPTURE === "1";
}

export async function captureWebhook(accountId: string | null | undefined, rawBody: string) {
  await execute(sql`
    INSERT INTO chatbase.webhook_inbox (account_id, raw_body)
    VALUES (${accountId ?? null}, ${rawBody})`);
}

export type CapturedWebhook = { id: string; accountId: string | null; rawBody: string };

export async function readCapturedWebhooks(limit: number): Promise<CapturedWebhook[]> {
  const rows = await execute(sql`
    SELECT TOP (${limit}) id, account_id, raw_body
    FROM chatbase.webhook_inbox
    WHERE processed_at IS NULL
    ORDER BY id`);
  return rows.map((row) => ({
    id: String(row.id),
    accountId: (row.account_id as string | null) ?? null,
    rawBody: row.raw_body as string,
  }));
}

export async function markWebhookProcessed(id: string) {
  await execute(sql`
    UPDATE chatbase.webhook_inbox
    SET processed_at = SYSUTCDATETIME()
    WHERE id = CAST(${id} AS bigint)`);
}

export async function countPendingWebhooks() {
  const [row] = await execute(sql`
    SELECT COUNT(*) AS pending FROM chatbase.webhook_inbox WHERE processed_at IS NULL`);
  return Number(row?.pending ?? 0);
}
