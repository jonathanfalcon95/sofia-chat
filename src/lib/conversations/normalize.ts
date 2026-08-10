import type { ContactTagRef, ConversationRow, NoteRow } from "./types";

export function normalizeConversations(
  rows: Array<Record<string, unknown>> | null | undefined,
): ConversationRow[] {
  return (
    rows?.map((c) => {
      const contactRaw = c.contacts;
      const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw;
      const ctags = (
        (
          contact as {
            contact_tags?: Array<{ tag_id: string; tags: unknown }>;
          } | null
        )?.contact_tags ?? []
      )
        .map((ct) => ({
          tag_id: ct.tag_id,
          tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
        }))
        .filter((ct) => Boolean(ct.tags));

      return {
        ...(c as unknown as ConversationRow),
        contacts: contact
          ? {
              id: (contact as { id: string }).id,
              name: (contact as { name: string | null }).name,
              phone_number: (contact as { phone_number: string }).phone_number,
              contact_tags: ctags as ContactTagRef[],
            }
          : null,
        inboxes: Array.isArray(c.inboxes) ? c.inboxes[0] : c.inboxes,
        conversation_tags: (
          (c.conversation_tags as ConversationRow["conversation_tags"]) ?? []
        ).map((ct) => ({
          tag_id: ct.tag_id,
          tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
        })),
      } as ConversationRow;
    }) ?? []
  );
}

export function normalizeNotes(
  rows: Array<Record<string, unknown>> | null | undefined,
): NoteRow[] {
  return (
    (rows as unknown as NoteRow[] | null)?.map((n) => ({
      ...n,
      profiles: Array.isArray(n.profiles) ? n.profiles[0] : n.profiles,
    })) ?? []
  );
}
