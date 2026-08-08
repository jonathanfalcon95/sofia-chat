-- Contact tags (non-kanban): many tags per contact

create table public.contact_tags (
  contact_id uuid not null references public.contacts (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

create index contact_tags_tag_id_idx on public.contact_tags (tag_id);

-- Only allow non-kanban tags on contacts
create or replace function public.enforce_contact_tag_not_kanban()
returns trigger
language plpgsql
as $$
declare
  v_is_kanban boolean;
begin
  select is_kanban_column into v_is_kanban from public.tags where id = new.tag_id;
  if coalesce(v_is_kanban, false) then
    raise exception 'Kanban tags cannot be assigned to contacts';
  end if;
  return new;
end;
$$;

create trigger contact_tags_not_kanban
  before insert on public.contact_tags
  for each row execute function public.enforce_contact_tag_not_kanban();

alter table public.contact_tags enable row level security;

create policy contact_tags_select on public.contact_tags for select to authenticated
  using (
    exists (
      select 1 from public.contacts c
      where c.id = contact_id
        and (public.has_permission(c.company_id, 'contacts.view') or public.has_company_access(c.company_id))
    )
  );

create policy contact_tags_mutate on public.contact_tags for all to authenticated
  using (
    exists (
      select 1 from public.contacts c
      where c.id = contact_id
        and public.has_permission(c.company_id, 'conversations.tag')
    )
  )
  with check (
    exists (
      select 1 from public.contacts c
      where c.id = contact_id
        and public.has_permission(c.company_id, 'conversations.tag')
    )
  );

-- Catalog CRUD for tags: management only (agents assign via contact_tags / conversation_tags)
drop policy if exists tags_mutate on public.tags;
create policy tags_mutate on public.tags for all to authenticated
  using (
    public.has_permission(company_id, 'kanban.manage')
    or public.has_permission(company_id, 'inboxes.manage')
  )
  with check (
    public.has_permission(company_id, 'kanban.manage')
    or public.has_permission(company_id, 'inboxes.manage')
  );

-- Seed a couple of contact tags for Empresa Demo
insert into public.tags (company_id, name, color, position, is_kanban_column)
values
  ('11111111-1111-1111-1111-111111111111', 'VIP', '#f59e0b', 100, false),
  ('11111111-1111-1111-1111-111111111111', 'Seguimiento', '#3b82f6', 101, false)
on conflict (company_id, name) do nothing;
