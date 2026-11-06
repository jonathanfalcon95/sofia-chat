import { usesSqlServer } from "@/lib/db/backend";
import { execute } from "@/lib/db/sqlserver/connection";
import { raw, sql, uuidList } from "@/lib/db/sqlserver/sql";
import { logSystemError } from "@/lib/errors/log-system-error";
import { maxBytesForKind, mediaKindFromMime, type MediaKind } from "@/lib/media";
import { isBlobStoreOn, putBlob } from "@/lib/storage/blob-store";
import { archiveBatch, type ArchiveDeps, type PendingMedia } from "@/lib/storage/media-archive";
import { deleteInBatches, retentionDays } from "@/lib/jobs/retention";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";
import { downloadYCloudMedia } from "@/lib/ycloud/client";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** YCloud's links last about 7 days; the extra day covers the edge without retrying dead links. */
const ARCHIVE_WINDOW_DAYS = 8;
const ARCHIVE_BATCH = 25;

const RETENTION_BATCH = 500;
const RETENTION_MAX_BATCHES = 40;

const FILE_TYPES = raw("(N'image', N'audio', N'video', N'document', N'sticker')");

export const archiveDeps: ArchiveDeps = {
  /** Oldest first: those are the links about to expire. */
  listPending: async (limit, excludeIds) => {
    const rows = await execute(sql`
      SELECT TOP (${limit}) m.id, m.company_id, m.conversation_id, m.type, m.media_url,
             m.media_mime, m.media_filename, c.inbox_id
      FROM chatbase.messages m
      JOIN chatbase.conversations c ON c.id = m.conversation_id
      WHERE m.type IN ${FILE_TYPES}
        AND m.created_at >= DATEADD(DAY, ${-ARCHIVE_WINDOW_DAYS}, SYSUTCDATETIME())
        AND m.media_url LIKE 'https://api.ycloud.com/%'
        ${excludeIds.length ? sql`AND m.id NOT IN ${uuidList(excludeIds)}` : raw("")}
      ORDER BY m.created_at`);
    return rows.map(
      (row): PendingMedia => ({
        id: row.id as string,
        companyId: row.company_id as string,
        conversationId: row.conversation_id as string,
        inboxId: (row.inbox_id as string | null) ?? null,
        type: row.type as string,
        mediaUrl: row.media_url as string,
        mime: (row.media_mime as string | null) ?? null,
        filename: (row.media_filename as string | null) ?? null,
      }),
    );
  },
  apiKeyFor: async (inboxId) => (await getInboxYCloudCredentials(inboxId)).apiKey,
  download: downloadYCloudMedia,
  put: (path, bytes, contentType) => putBlob("chat-media", path, bytes, contentType),
  setMediaUrl: async (id, currentUrl, newUrl) => {
    await execute(sql`
      UPDATE chatbase.messages SET media_url = ${newUrl}
      WHERE id = CAST(${id} AS uniqueidentifier) AND media_url = ${currentUrl}`);
  },
  maxBytes: (type, mime) =>
    maxBytesForKind(mediaKindFromMime(mime) ?? (type as MediaKind), true),
};

const gaveUp = new Set<string>();

async function archiveMedia() {
  if (!isBlobStoreOn()) return;
  const result = await archiveBatch(archiveDeps, gaveUp, ARCHIVE_BATCH);
  if (result.archived || result.gone || result.failed) {
    console.info("[jobs] media archive", JSON.stringify({ ...result, gaveUp: gaveUp.size }));
  }
  if (result.stoppedEarly) throw new Error("media archive stopped after repeated failures");
}

async function deleteOldEvents() {
  const days = retentionDays(process.env.EVENT_RETENTION_DAYS);
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  const deleted = async (statement: ReturnType<typeof sql>) => {
    const [row] = await execute(statement);
    return Number(row?.deleted ?? 0);
  };
  const events = await deleteInBatches({
    deleteBatch: (size) =>
      deleted(sql`
        DELETE TOP (${size}) FROM chatbase.webhook_events
        WHERE processed_at < DATEADD(DAY, ${-days}, SYSUTCDATETIME());
        SELECT @@ROWCOUNT AS deleted;`),
    batchSize: RETENTION_BATCH,
    maxBatches: RETENTION_MAX_BATCHES,
    pause,
  });
  // processed_at IS NULL never matches, so webhooks still waiting are kept.
  const inbox = await deleteInBatches({
    deleteBatch: (size) =>
      deleted(sql`
        DELETE TOP (${size}) FROM chatbase.webhook_inbox
        WHERE processed_at < DATEADD(DAY, ${-days}, SYSUTCDATETIME());
        SELECT @@ROWCOUNT AS deleted;`),
    batchSize: RETENTION_BATCH,
    maxBatches: RETENTION_MAX_BATCHES,
    pause,
  });
  if (events || inbox) {
    console.info("[jobs] event retention", JSON.stringify({ days, events, inbox }));
  }
}

function schedule(name: string, firstDelay: number, every: number, work: () => Promise<void>) {
  let running = false;
  let lastLogged = 0;

  const run = async () => {
    // During a change of database nothing may write, and a run must never overlap the last one.
    if (running || process.env.MAINTENANCE_MODE === "1" || process.env.WEBHOOK_CAPTURE === "1") {
      return;
    }
    running = true;
    try {
      await work();
    } catch (err) {
      console.error(`[jobs] ${name} failed`, err);
      if (Date.now() - lastLogged >= HOUR) {
        lastLogged = Date.now();
        await logSystemError({
          source: "jobs.background",
          message: `${name} failed`,
          error: err,
          level: "warn",
          errorCode: "background_job_failed",
          context: { job: name },
        }).catch(() => {});
      }
    } finally {
      running = false;
    }
  };

  // unref: a timer must not keep a process alive that is shutting down.
  setTimeout(() => {
    void run();
    setInterval(() => void run(), every).unref();
  }, firstDelay).unref();
}

const started = globalThis as unknown as { __chatbaseJobsStarted?: boolean };

/**
 * Timers in the server process: the app has one instance, and every job is safe to repeat. They run
 * only where BACKGROUND_JOBS=1, so `next dev` with production credentials cannot delete anything.
 */
export function startBackgroundJobs() {
  if (process.env.BACKGROUND_JOBS !== "1" || !usesSqlServer() || started.__chatbaseJobsStarted) {
    return;
  }
  started.__chatbaseJobsStarted = true;
  schedule("media archive", 2 * MINUTE, MINUTE, archiveMedia);
  schedule("event retention", 5 * MINUTE, HOUR, deleteOldEvents);
  console.info("[jobs] started");
}
