import { accessOf, type SqlDb } from "../db";
import { isUuid, sql, where } from "../sql";
import { maybeOne, messageVisible } from "./shared";

export async function findMessageMedia(db: SqlDb, messageId: string) {
  return maybeOne(async () => {
    if (!isUuid(messageId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT m.id, m.media_url, m.media_mime, m.type, m.body, m.media_filename, m.conversation_id
      FROM chatbase.messages m
      ${where([
        sql`m.id = ${messageId}`,
        access ? messageVisible(access, "m.conversation_id") : null,
      ])}`);
  });
}
