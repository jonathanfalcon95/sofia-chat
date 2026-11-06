import { isSqlDb } from "../sqlserver/db";
import * as sql from "../sqlserver/repos/media";
import type { Db } from "../types";

export async function findMessageMedia(db: Db, messageId: string) {
  if (isSqlDb(db)) return sql.findMessageMedia(db, messageId);

  return db
    .from("messages")
    .select("id, media_url, media_mime, type, body, media_filename, conversation_id")
    .eq("id", messageId)
    .maybeSingle();
}
