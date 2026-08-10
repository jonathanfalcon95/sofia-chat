export type ContactTagRef = {
  tag_id: string;
  tags: { id: string; name: string; color: string } | null;
};

export type ConversationRow = {
  id: string;
  company_id: string;
  inbox_id: string;
  contact_id?: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  window_expires_at: string | null;
  assignee_id: string | null;
  unread_count: number;
  contacts: {
    id: string;
    name: string | null;
    phone_number: string;
    contact_tags?: ContactTagRef[];
  } | null;
  inboxes: { name: string; phone_number?: string | null } | null;
  conversation_tags: Array<{
    tag_id: string;
    tags: { id: string; name: string; color: string } | null;
  }>;
};

export type MessageRow = {
  id: string;
  conversation_id?: string;
  direction: string;
  type: string;
  body: string | null;
  status: string;
  created_at: string;
  template_name: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  media_filename?: string | null;
  /** Client-only blob URL for optimistic outbound media. */
  localPreviewUrl?: string | null;
};

export type NoteRow = {
  id: string;
  body: string;
  created_at: string;
  profiles: { full_name: string | null; email: string } | null;
};

export type AssigneeFilter = "all" | "mine" | "unassigned";

export const MESSAGE_PAGE_SIZE = 50;

export const CONVERSATION_LIST_SELECT = `
  id, company_id, inbox_id, status, last_message_at, last_message_preview,
  window_expires_at, assignee_id, unread_count, contact_id,
  contacts (
    id, name, phone_number,
    contact_tags ( tag_id, tags ( id, name, color ) )
  ),
  inboxes ( name ),
  conversation_tags ( tag_id, tags ( id, name, color ) )
`;
