import { scope } from "../access";
import { accessOf, done, inTransaction, one, type SqlDb } from "../db";
import { isUuid, sql, where } from "../sql";
import {
  idsOf,
  listRows,
  profileEmbed,
  requireConversationPermission,
  visibleProfiles,
} from "./conversation-embeds";

export async function listConversationNotes(db: SqlDb, conversationId: string) {
  return listRows(async () => {
    if (!isUuid(conversationId)) return [];
    const access = await accessOf(db);
    const notes = await db.run(sql`
      SELECT n.id, n.body, n.created_at, n.author_id
      FROM chatbase.conversation_notes n
      ${where([
        sql`n.conversation_id = ${conversationId}`,
        access
          ? sql`EXISTS (SELECT 1 FROM chatbase.conversations c
                        WHERE c.id = n.conversation_id AND ${scope.inbox(access, "c.inbox_id")})`
          : null,
      ])}
      ORDER BY n.created_at DESC`);
    const profiles = await visibleProfiles(db, access, idsOf(notes, "author_id"));
    return notes.map((note) => ({
      id: note.id,
      body: note.body,
      created_at: note.created_at,
      profiles: profileEmbed(profiles, note.author_id),
    }));
  });
}

export async function insertConversationNote(
  db: SqlDb,
  note: {
    conversationId: string;
    companyId: string;
    authorId: string;
    body: string;
  },
) {
  return one(async () => {
    const access = await accessOf(db);
    return inTransaction(db, async (tx) => {
      await requireConversationPermission(tx, access, note.conversationId, "notes.manage");
      const inserted = await tx.run(sql`
        INSERT INTO chatbase.conversation_notes (conversation_id, company_id, author_id, body)
        OUTPUT INSERTED.id, INSERTED.body, INSERTED.created_at, INSERTED.author_id
        VALUES (${note.conversationId}, ${note.companyId}, ${note.authorId}, ${note.body})`);
      const profiles = await visibleProfiles(tx, access, idsOf(inserted, "author_id"));
      return inserted.map((row) => ({
        id: row.id,
        body: row.body,
        created_at: row.created_at,
        profiles: profileEmbed(profiles, row.author_id),
      }));
    });
  });
}

export async function removeConversationNote(db: SqlDb, noteId: string, conversationId: string) {
  return done(async () => {
    if (!isUuid(noteId) || !isUuid(conversationId)) return;
    const access = await accessOf(db);
    await db.run(sql`
      DELETE n FROM chatbase.conversation_notes n
      ${where([
        sql`n.id = ${noteId}`,
        sql`n.conversation_id = ${conversationId}`,
        access
          ? sql`EXISTS (SELECT 1 FROM chatbase.conversations c
                        WHERE c.id = n.conversation_id
                          AND ${scope.inbox(access, "c.inbox_id")}
                          AND ${scope.companyWith(access, "c.company_id", "notes.manage")})`
          : null,
      ])}`);
  });
}
