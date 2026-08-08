-- Chatbase initial schema: multi-tenant WhatsApp inbox
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenancy & profiles
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_memberships_user_id_idx on public.company_memberships (user_id);
create index company_memberships_company_id_idx on public.company_memberships (company_id);

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------
create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id) on delete cascade,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

create table public.membership_roles (
  membership_id uuid not null references public.company_memberships (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete cascade,
  primary key (membership_id, role_id)
);

-- ---------------------------------------------------------------------------
-- Inboxes (WhatsApp numbers)
-- ---------------------------------------------------------------------------
create table public.inboxes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  phone_number text not null,
  ycloud_phone_number_id text,
  waba_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone_number)
);

create index inboxes_company_id_idx on public.inboxes (company_id);

create table public.membership_inboxes (
  membership_id uuid not null references public.company_memberships (id) on delete cascade,
  inbox_id uuid not null references public.inboxes (id) on delete cascade,
  primary key (membership_id, inbox_id)
);

-- ---------------------------------------------------------------------------
-- Contacts, conversations, messages
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  phone_number text not null,
  name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, phone_number)
);

create index contacts_company_id_idx on public.contacts (company_id);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  inbox_id uuid not null references public.inboxes (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  assignee_id uuid references public.profiles (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  window_expires_at timestamptz,
  last_message_preview text,
  unread_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (inbox_id, contact_id)
);

create index conversations_inbox_last_msg_idx on public.conversations (inbox_id, last_message_at desc nulls last);
create index conversations_company_id_idx on public.conversations (company_id);
create index conversations_assignee_id_idx on public.conversations (assignee_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  type text not null default 'text',
  body text,
  template_name text,
  template_language text,
  template_components jsonb,
  ycloud_message_id text unique,
  status text not null default 'received',
  media_url text,
  raw_payload jsonb,
  sent_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Tags / Kanban
-- ---------------------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null,
  color text not null default '#64748b',
  position integer not null default 0,
  is_kanban_column boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create index tags_company_position_idx on public.tags (company_id, position);

create table public.conversation_tags (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);

-- Enforce one kanban column tag per conversation in app layer + trigger
create or replace function public.enforce_one_kanban_tag()
returns trigger
language plpgsql
as $$
declare
  v_is_kanban boolean;
begin
  select is_kanban_column into v_is_kanban from public.tags where id = new.tag_id;
  if coalesce(v_is_kanban, false) then
    delete from public.conversation_tags ct
    using public.tags t
    where ct.conversation_id = new.conversation_id
      and ct.tag_id = t.id
      and t.is_kanban_column = true
      and ct.tag_id <> new.tag_id;
  end if;
  return new;
end;
$$;

create trigger conversation_tags_one_kanban
  before insert on public.conversation_tags
  for each row execute function public.enforce_one_kanban_tag();

-- ---------------------------------------------------------------------------
-- Notes & tickets
-- ---------------------------------------------------------------------------
create table public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  assignee_id uuid references public.profiles (id) on delete set null,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tickets_company_status_idx on public.tickets (company_id, status);

-- ---------------------------------------------------------------------------
-- Webhook idempotency
-- ---------------------------------------------------------------------------
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  ycloud_event_id text not null unique,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger companies_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger roles_updated_at before update on public.roles
  for each row execute function public.set_updated_at();
create trigger inboxes_updated_at before update on public.inboxes
  for each row execute function public.set_updated_at();
create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();
create trigger tickets_updated_at before update on public.tickets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auth profile sync
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RBAC helper functions (security definer, auth.uid check inside)
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

create or replace function public.has_company_access(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
      select 1
      from public.company_memberships m
      where m.company_id = p_company_id
        and m.user_id = auth.uid()
        and m.is_active = true
    );
$$;

create or replace function public.has_permission(p_company_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
      select 1
      from public.company_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp on rp.role_id = mr.role_id
      join public.permissions p on p.id = rp.permission_id
      where m.company_id = p_company_id
        and m.user_id = auth.uid()
        and m.is_active = true
        and p.code = p_permission
    );
$$;

create or replace function public.has_inbox_access(p_inbox_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_platform_admin()
    or exists (
      select 1
      from public.inboxes i
      join public.company_memberships m on m.company_id = i.company_id
      where i.id = p_inbox_id
        and m.user_id = auth.uid()
        and m.is_active = true
        and (
          public.has_permission(i.company_id, 'inboxes.manage')
          or exists (
            select 1
            from public.membership_inboxes mi
            where mi.membership_id = m.id
              and mi.inbox_id = i.id
          )
        )
    );
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.has_company_access(uuid) from public;
revoke all on function public.has_permission(uuid, text) from public;
revoke all on function public.has_inbox_access(uuid) from public;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.has_company_access(uuid) to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;
grant execute on function public.has_inbox_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (code, description) values
  ('companies.manage', 'Administrar empresas de la plataforma'),
  ('users.manage', 'Crear y gestionar usuarios de la empresa'),
  ('roles.manage', 'Crear roles y asignar permisos'),
  ('inboxes.manage', 'Administrar inboxes / números'),
  ('inboxes.view', 'Ver inboxes asignados'),
  ('conversations.view', 'Ver conversaciones'),
  ('conversations.reply', 'Responder conversaciones'),
  ('conversations.assign', 'Asignar conversaciones a agentes'),
  ('conversations.tag', 'Etiquetar / mover kanban'),
  ('notes.manage', 'Crear notas internas'),
  ('tickets.manage', 'Crear y gestionar tickets'),
  ('tickets.view', 'Ver tickets'),
  ('contacts.view', 'Ver contactos'),
  ('templates.send', 'Enviar plantillas WhatsApp'),
  ('kanban.manage', 'Administrar columnas kanban'),
  ('tags.manage', 'Crear y gestionar tags de contacto');

-- ---------------------------------------------------------------------------
-- Seed demo company + template roles + sales kanban tags
-- ---------------------------------------------------------------------------
insert into public.companies (id, name, slug)
values ('11111111-1111-1111-1111-111111111111', 'Empresa Demo', 'empresa-demo');

-- System role templates (company_id null) — cloned per company as needed
insert into public.roles (id, company_id, name, description, is_system) values
  ('22222222-2222-2222-2222-222222222201', null, 'Admin', 'Administrador de empresa', true),
  ('22222222-2222-2222-2222-222222222202', null, 'Agente', 'Agente de atención', true),
  ('22222222-2222-2222-2222-222222222203', null, 'Soporte', 'Soporte / tickets', true);

-- Company-scoped copies for demo
insert into public.roles (id, company_id, name, description, is_system) values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', 'Admin', 'Administrador de empresa', true),
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111', 'Agente', 'Agente de atención', true),
  ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111111', 'Soporte', 'Soporte / tickets', true);

-- Admin template + demo admin: all perms except companies.manage optional for company admin
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'Admin'
  and p.code <> 'companies.manage';

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'Agente'
  and p.code in (
    'inboxes.view', 'conversations.view', 'conversations.reply',
    'conversations.assign', 'conversations.tag', 'notes.manage',
    'tickets.view', 'tickets.manage', 'contacts.view', 'templates.send',
    'tags.manage'
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'Soporte'
  and p.code in (
    'inboxes.view', 'conversations.view', 'notes.manage',
    'tickets.view', 'tickets.manage', 'contacts.view'
  );

insert into public.tags (company_id, name, color, position, is_kanban_column) values
  ('11111111-1111-1111-1111-111111111111', 'Nuevo lead', '#3b82f6', 1, true),
  ('11111111-1111-1111-1111-111111111111', 'Contactado', '#06b6d4', 2, true),
  ('11111111-1111-1111-1111-111111111111', 'Calificado', '#8b5cf6', 3, true),
  ('11111111-1111-1111-1111-111111111111', 'Propuesta', '#f59e0b', 4, true),
  ('11111111-1111-1111-1111-111111111111', 'Negociación', '#f97316', 5, true),
  ('11111111-1111-1111-1111-111111111111', 'Ganado', '#22c55e', 6, true),
  ('11111111-1111-1111-1111-111111111111', 'Perdido', '#ef4444', 7, true);

insert into public.inboxes (id, company_id, name, phone_number) values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 'WhatsApp Principal', '+10000000001'),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111', 'WhatsApp Ventas', '+10000000002');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.companies enable row level security;
alter table public.profiles enable row level security;
alter table public.company_memberships enable row level security;
alter table public.permissions enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.membership_roles enable row level security;
alter table public.inboxes enable row level security;
alter table public.membership_inboxes enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.tags enable row level security;
alter table public.conversation_tags enable row level security;
alter table public.conversation_notes enable row level security;
alter table public.tickets enable row level security;
alter table public.webhook_events enable row level security;

-- Companies
create policy companies_select on public.companies for select to authenticated
  using (public.is_platform_admin() or public.has_company_access(id));
create policy companies_insert on public.companies for insert to authenticated
  with check (public.is_platform_admin());
create policy companies_update on public.companies for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
create policy companies_delete on public.companies for delete to authenticated
  using (public.is_platform_admin());

-- Profiles
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.is_platform_admin()
    or exists (
      select 1 from public.company_memberships m1
      join public.company_memberships m2 on m1.company_id = m2.company_id
      where m1.user_id = (select auth.uid())
        and m2.user_id = profiles.id
        and m1.is_active and m2.is_active
    )
  );
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) or public.is_platform_admin())
  with check (id = (select auth.uid()) or public.is_platform_admin());

-- Memberships
create policy memberships_select on public.company_memberships for select to authenticated
  using (public.has_company_access(company_id));
create policy memberships_insert on public.company_memberships for insert to authenticated
  with check (public.is_platform_admin() or public.has_permission(company_id, 'users.manage'));
create policy memberships_update on public.company_memberships for update to authenticated
  using (public.is_platform_admin() or public.has_permission(company_id, 'users.manage'))
  with check (public.is_platform_admin() or public.has_permission(company_id, 'users.manage'));
create policy memberships_delete on public.company_memberships for delete to authenticated
  using (public.is_platform_admin() or public.has_permission(company_id, 'users.manage'));

-- Permissions (read-only catalog)
create policy permissions_select on public.permissions for select to authenticated
  using (true);

-- Roles
create policy roles_select on public.roles for select to authenticated
  using (company_id is null or public.has_company_access(company_id));
create policy roles_insert on public.roles for insert to authenticated
  with check (company_id is not null and public.has_permission(company_id, 'roles.manage'));
create policy roles_update on public.roles for update to authenticated
  using (company_id is not null and public.has_permission(company_id, 'roles.manage'))
  with check (company_id is not null and public.has_permission(company_id, 'roles.manage'));
create policy roles_delete on public.roles for delete to authenticated
  using (company_id is not null and public.has_permission(company_id, 'roles.manage') and is_system = false);

create policy role_permissions_select on public.role_permissions for select to authenticated
  using (
    exists (
      select 1 from public.roles r
      where r.id = role_id
        and (r.company_id is null or public.has_company_access(r.company_id))
    )
  );
create policy role_permissions_mutate on public.role_permissions for all to authenticated
  using (
    exists (
      select 1 from public.roles r
      where r.id = role_id
        and r.company_id is not null
        and public.has_permission(r.company_id, 'roles.manage')
    )
  )
  with check (
    exists (
      select 1 from public.roles r
      where r.id = role_id
        and r.company_id is not null
        and public.has_permission(r.company_id, 'roles.manage')
    )
  );

create policy membership_roles_select on public.membership_roles for select to authenticated
  using (
    exists (
      select 1 from public.company_memberships m
      where m.id = membership_id and public.has_company_access(m.company_id)
    )
  );
create policy membership_roles_mutate on public.membership_roles for all to authenticated
  using (
    exists (
      select 1 from public.company_memberships m
      where m.id = membership_id
        and (public.is_platform_admin() or public.has_permission(m.company_id, 'users.manage'))
    )
  )
  with check (
    exists (
      select 1 from public.company_memberships m
      where m.id = membership_id
        and (public.is_platform_admin() or public.has_permission(m.company_id, 'users.manage'))
    )
  );

-- Inboxes
create policy inboxes_select on public.inboxes for select to authenticated
  using (public.has_inbox_access(id) or public.has_permission(company_id, 'inboxes.manage'));
create policy inboxes_insert on public.inboxes for insert to authenticated
  with check (public.is_platform_admin() or public.has_permission(company_id, 'inboxes.manage'));
create policy inboxes_update on public.inboxes for update to authenticated
  using (public.is_platform_admin() or public.has_permission(company_id, 'inboxes.manage'))
  with check (public.is_platform_admin() or public.has_permission(company_id, 'inboxes.manage'));
create policy inboxes_delete on public.inboxes for delete to authenticated
  using (public.is_platform_admin() or public.has_permission(company_id, 'inboxes.manage'));

create policy membership_inboxes_select on public.membership_inboxes for select to authenticated
  using (
    exists (
      select 1 from public.company_memberships m
      where m.id = membership_id and public.has_company_access(m.company_id)
    )
  );
create policy membership_inboxes_mutate on public.membership_inboxes for all to authenticated
  using (
    exists (
      select 1 from public.company_memberships m
      where m.id = membership_id
        and (public.is_platform_admin() or public.has_permission(m.company_id, 'users.manage'))
    )
  )
  with check (
    exists (
      select 1 from public.company_memberships m
      where m.id = membership_id
        and (public.is_platform_admin() or public.has_permission(m.company_id, 'users.manage'))
    )
  );

-- Contacts
create policy contacts_select on public.contacts for select to authenticated
  using (public.has_permission(company_id, 'contacts.view') or public.has_company_access(company_id));
create policy contacts_mutate on public.contacts for all to authenticated
  using (public.has_company_access(company_id))
  with check (public.has_company_access(company_id));

-- Conversations
create policy conversations_select on public.conversations for select to authenticated
  using (
    public.has_inbox_access(inbox_id)
    and public.has_permission(company_id, 'conversations.view')
  );
create policy conversations_insert on public.conversations for insert to authenticated
  with check (public.has_inbox_access(inbox_id));
create policy conversations_update on public.conversations for update to authenticated
  using (public.has_inbox_access(inbox_id))
  with check (public.has_inbox_access(inbox_id));

-- Messages
create policy messages_select on public.messages for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.has_inbox_access(c.inbox_id)
    )
  );
create policy messages_insert on public.messages for insert to authenticated
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and public.has_inbox_access(c.inbox_id)
        and public.has_permission(c.company_id, 'conversations.reply')
    )
  );
create policy messages_update on public.messages for update to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.has_inbox_access(c.inbox_id)
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.has_inbox_access(c.inbox_id)
    )
  );

-- Tags
create policy tags_select on public.tags for select to authenticated
  using (public.has_company_access(company_id));
create policy tags_mutate on public.tags for all to authenticated
  using (public.has_permission(company_id, 'kanban.manage') or public.has_permission(company_id, 'conversations.tag'))
  with check (public.has_permission(company_id, 'kanban.manage') or public.has_permission(company_id, 'conversations.tag'));

create policy conversation_tags_select on public.conversation_tags for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.has_inbox_access(c.inbox_id)
    )
  );
create policy conversation_tags_mutate on public.conversation_tags for all to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and public.has_inbox_access(c.inbox_id)
        and public.has_permission(c.company_id, 'conversations.tag')
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and public.has_inbox_access(c.inbox_id)
        and public.has_permission(c.company_id, 'conversations.tag')
    )
  );

-- Notes
create policy notes_select on public.conversation_notes for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id and public.has_inbox_access(c.inbox_id)
    )
  );
create policy notes_insert on public.conversation_notes for insert to authenticated
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and public.has_inbox_access(c.inbox_id)
        and public.has_permission(c.company_id, 'notes.manage')
    )
  );

-- Tickets
create policy tickets_select on public.tickets for select to authenticated
  using (public.has_permission(company_id, 'tickets.view') or public.has_permission(company_id, 'tickets.manage'));
create policy tickets_insert on public.tickets for insert to authenticated
  with check (public.has_permission(company_id, 'tickets.manage'));
create policy tickets_update on public.tickets for update to authenticated
  using (public.has_permission(company_id, 'tickets.manage'))
  with check (public.has_permission(company_id, 'tickets.manage'));

-- Webhook events: no client access
create policy webhook_events_deny on public.webhook_events for all to authenticated
  using (false) with check (false);

-- Grants for Data API
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.permissions to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Realtime
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversation_tags;
alter publication supabase_realtime add table public.tickets;
