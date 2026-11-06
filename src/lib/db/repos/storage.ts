import { createAdminClient } from "@/lib/supabase/admin";
import { getBlob, isBlobStoreOn, putBlob } from "@/lib/storage/blob-store";
import { downloadWithFallback, uploadWithFallback } from "@/lib/storage/chat-media-store";
import { failure, isSqlDb, type SqlResult } from "../sqlserver/db";
import type { Db } from "../types";

const CHAT_MEDIA = "chat-media";

/** An SqlDb has no storage of its own, so Supabase Storage goes through the admin client. */
async function onAdminStorage<T>(work: (storage: Db["storage"]) => Promise<T>) {
  try {
    return await work(createAdminClient().storage);
  } catch (err) {
    return failure(err) as SqlResult<never>;
  }
}

/** Stores a file for the chat; never overwrites an existing object. */
export async function uploadChatMedia(
  db: Db,
  objectPath: string,
  bytes: Buffer,
  contentType: string,
) {
  const toSupabase = async () => {
    if (isSqlDb(db)) {
      return onAdminStorage((storage) =>
        storage.from(CHAT_MEDIA).upload(objectPath, bytes, {
          contentType,
          upsert: false,
        }),
      );
    }
    return db.storage.from(CHAT_MEDIA).upload(objectPath, bytes, {
      contentType,
      upsert: false,
    });
  };

  if (!isBlobStoreOn()) return toSupabase();
  return uploadWithFallback({
    toBlob: () => putBlob(CHAT_MEDIA, objectPath, bytes, contentType),
    toSupabase,
    onBlobError: (err) => console.error("chat-media blob upload failed", err),
  });
}

export async function downloadStorageObject(
  db: Db,
  bucket: string,
  path: string,
) {
  const fromSupabase = async () => {
    if (isSqlDb(db)) {
      return onAdminStorage((storage) => storage.from(bucket).download(path));
    }
    return db.storage.from(bucket).download(path);
  };

  if (!isBlobStoreOn() || bucket !== CHAT_MEDIA) return fromSupabase();
  return downloadWithFallback({
    fromBlob: () => getBlob(CHAT_MEDIA, path),
    fromSupabase,
    onBlobError: (err) => console.error("chat-media blob read failed", err),
  });
}
