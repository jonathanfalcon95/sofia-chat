alter table public.tickets
  add column if not exists support_response text,
  add column if not exists support_responded_at timestamptz,
  add column if not exists support_responded_by uuid references public.profiles (id) on delete set null;

create index if not exists tickets_created_by_idx on public.tickets (created_by);
create index if not exists tickets_assignee_id_idx on public.tickets (assignee_id);
