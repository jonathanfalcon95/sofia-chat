-- Improve thread side-panel note loading by conversation and recency.
create index if not exists conversation_notes_conversation_created_idx
  on public.conversation_notes (conversation_id, created_at desc);
