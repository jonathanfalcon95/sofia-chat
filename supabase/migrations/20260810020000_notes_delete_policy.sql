-- Allow deleting internal conversation notes with the same gate as insert.
create policy notes_delete on public.conversation_notes
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and public.has_inbox_access(c.inbox_id)
        and public.has_permission(c.company_id, 'notes.manage')
    )
  );
