import type { Db } from "../types";

export async function findMessageMedia(db: Db, messageId: string) {
  return db
    .from("messages")
    .select("id, media_url, media_mime, type, body, media_filename, conversation_id")
    .eq("id", messageId)
    .maybeSingle();
}
