import type { Db } from "../types";

export async function listConversationNotes(db: Db, conversationId: string) {
  return db
    .from("conversation_notes")
    .select("id, body, created_at, profiles(full_name, email)")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });
}

export async function insertConversationNote(
  db: Db,
  note: {
    conversationId: string;
    companyId: string;
    authorId: string;
    body: string;
  },
) {
  return db
    .from("conversation_notes")
    .insert({
      conversation_id: note.conversationId,
      company_id: note.companyId,
      author_id: note.authorId,
      body: note.body,
    })
    .select("id, body, created_at, profiles(full_name, email)")
    .single();
}

export async function removeConversationNote(
  db: Db,
  noteId: string,
  conversationId: string,
) {
  return db
    .from("conversation_notes")
    .delete()
    .eq("id", noteId)
    .eq("conversation_id", conversationId);
}
