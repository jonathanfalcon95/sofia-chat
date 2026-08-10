-- System error logs for platform ops (cedible via error_logs.view)

insert into public.permissions (code, description)
values ('error_logs.view', 'Ver y triajar log de errores del sistema')
on conflict (code) do update set description = excluded.description;

-- Not seeded onto Admin / Agente / Soporte (same pattern as companies.manage)

create table public.error_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  level text not null default 'error'
    check (level in ('error', 'warn', 'fatal')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'ignored')),
  source text not null,
  message text not null,
  error_name text,
  error_code text,
  http_status integer,
  stack text,
  context jsonb not null default '{}'::jsonb,
  company_id uuid references public.companies (id) on delete set null,
  user_id uuid references public.profiles (id) on delete set null,
  request_id text,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution_note text
);

create index error_logs_created_at_idx on public.error_logs (created_at desc);
create index error_logs_status_created_at_idx
  on public.error_logs (status, created_at desc);
create index error_logs_source_created_at_idx
  on public.error_logs (source, created_at desc);
create index error_logs_company_id_created_at_idx
  on public.error_logs (company_id, created_at desc)
  where company_id is not null;

create trigger error_logs_updated_at
  before update on public.error_logs
  for each row execute function public.set_updated_at();

create or replace function public.has_error_logs_access()
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
      where m.user_id = auth.uid()
        and m.is_active = true
        and p.code = 'error_logs.view'
    );
$$;

revoke all on function public.has_error_logs_access() from public;
grant execute on function public.has_error_logs_access() to authenticated;

alter table public.error_logs enable row level security;

create policy error_logs_select on public.error_logs
  for select to authenticated
  using (public.has_error_logs_access());

create policy error_logs_update on public.error_logs
  for update to authenticated
  using (public.has_error_logs_access())
  with check (public.has_error_logs_access());

create policy error_logs_insert_deny on public.error_logs
  for insert to authenticated
  with check (false);

create policy error_logs_delete_deny on public.error_logs
  for delete to authenticated
  using (false);

grant select, update on public.error_logs to authenticated;
