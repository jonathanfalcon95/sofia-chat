import type { Db } from "../types";

/** Stores a file in the chat-media bucket; never overwrites an existing object. */
export async function uploadChatMedia(
  db: Db,
  objectPath: string,
  bytes: Buffer,
  contentType: string,
) {
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
  return db.storage.from(bucket).download(path);
}
