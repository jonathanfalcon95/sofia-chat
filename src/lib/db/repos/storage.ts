import { createAdminClient } from "@/lib/supabase/admin";
import { failure, isSqlDb, type SqlResult } from "../sqlserver/db";
import type { Db } from "../types";

/** Files stay on Supabase Storage on both backends, and an SqlDb has no storage of its own. */
async function onAdminStorage<T>(work: (storage: Db["storage"]) => Promise<T>) {
  try {
    return await work(createAdminClient().storage);
  } catch (err) {
    return failure(err) as SqlResult<never>;
  }
}

/** Stores a file in the chat-media bucket; never overwrites an existing object. */
export async function uploadChatMedia(
  db: Db,
  objectPath: string,
  bytes: Buffer,
  contentType: string,
) {
  if (isSqlDb(db)) {
    return onAdminStorage((storage) =>
      storage.from("chat-media").upload(objectPath, bytes, {
        contentType,
        upsert: false,
      }),
    );
  }

  return db.storage.from("chat-media").upload(objectPath, bytes, {
    contentType,
    upsert: false,
  });
}

export async function downloadStorageObject(
  db: Db,
  bucket: string,
  path: string,
) {
  if (isSqlDb(db)) {
    return onAdminStorage((storage) => storage.from(bucket).download(path));
  }

  return db.storage.from(bucket).download(path);
}
