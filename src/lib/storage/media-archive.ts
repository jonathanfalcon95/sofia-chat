/**
 * Files a contact or another system sends live only on YCloud, whose links stop working after about
 * 7 days. This keeps a copy in the app's own storage and points the message at it.
 */

export type PendingMedia = {
  id: string;
  companyId: string;
  conversationId: string;
  inboxId: string | null;
  type: string;
  mediaUrl: string;
  mime: string | null;
  filename: string | null;
};

export type ArchiveDeps = {
  listPending: (limit: number, excludeIds: string[]) => Promise<PendingMedia[]>;
  apiKeyFor: (inboxId: string) => Promise<string>;
  download: (url: string, apiKey: string) => Promise<Response>;
  /** Must not fail when the same path already exists, so a repeated run is harmless. */
  put: (path: string, bytes: Buffer, contentType: string) => Promise<unknown>;
  /** Updates only if the row still holds `currentUrl`. */
  setMediaUrl: (id: string, currentUrl: string, newUrl: string) => Promise<void>;
  maxBytes: (type: string, mime: string) => number;
};

export type ArchiveResult = {
  archived: number;
  gone: number;
  failed: number;
  stoppedEarly: boolean;
};

const STOP_AFTER_FAILURES = 3;

export function archivePath(item: PendingMedia) {
  const name = (item.filename ?? "file").replace(/[^\w.\-]+/g, "_").slice(-100);
  return `ycloud/${item.companyId}/${item.conversationId}/${item.id}-${name}`;
}

export function chatMediaRef(path: string) {
  return `storage:chat-media/${path}`;
}

/**
 * One pass. `gaveUp` holds ids that will never succeed, such as expired links, and persists between
 * passes so they stop being retried. Temporary failures stay out of it and retry on the next pass;
 * several in a row end the pass, because YCloud or Blob is probably down.
 */
export async function archiveBatch(
  deps: ArchiveDeps,
  gaveUp: Set<string>,
  limit: number,
): Promise<ArchiveResult> {
  const result: ArchiveResult = { archived: 0, gone: 0, failed: 0, stoppedEarly: false };
  const keys = new Map<string, string>();
  let failuresInARow = 0;

  for (const item of await deps.listPending(limit, [...gaveUp])) {
    if (failuresInARow >= STOP_AFTER_FAILURES) {
      result.stoppedEarly = true;
      break;
    }
    try {
      if (!item.inboxId) {
        gaveUp.add(item.id);
        result.gone += 1;
        continue;
      }
      let key = keys.get(item.inboxId);
      if (!key) {
        key = await deps.apiKeyFor(item.inboxId);
        keys.set(item.inboxId, key);
      }

      const response = await deps.download(item.mediaUrl, key);
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        gaveUp.add(item.id);
        result.gone += 1;
        failuresInARow = 0;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`download ${response.status}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = item.mime || response.headers.get("content-type") || "application/octet-stream";
      if (bytes.length === 0) throw new Error("empty download");
      if (bytes.length > deps.maxBytes(item.type, mime)) {
        gaveUp.add(item.id);
        result.gone += 1;
        failuresInARow = 0;
        continue;
      }

      const path = archivePath(item);
      await deps.put(path, bytes, mime);
      await deps.setMediaUrl(item.id, item.mediaUrl, chatMediaRef(path));
      result.archived += 1;
      failuresInARow = 0;
    } catch (err) {
      result.failed += 1;
      failuresInARow += 1;
      console.error("media archive failed", item.id, err instanceof Error ? err.message : err);
    }
  }
  return result;
}
