-- Super Admin is profiles.is_platform_admin (not a company role).
-- Lock the flag, lock platform permission grants, and index inbox-by-company.

-- 1. Bootstrap existing local/prod admin (Auth user must already exist).
update public.profiles
set is_platform_admin = true
where lower(email) = 'admin@chatbase.local'
  and is_platform_admin is distinct from true;

-- 2. Block self-escalation: only an existing Super Admin (or no JWT / migration) can change the flag.
create or replace function public.prevent_platform_admin_escalation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_platform_admin is not distinct from old.is_platform_admin then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  if not public.is_platform_admin() then
    raise exception 'No puedes modificar el rol Super Admin';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_prevent_platform_admin_escalation on public.profiles;
create trigger profiles_prevent_platform_admin_escalation
  before update on public.profiles
  for each row
  execute function public.prevent_platform_admin_escalation();

revoke all on function public.prevent_platform_admin_escalation() from public;
grant execute on function public.prevent_platform_admin_escalation() to authenticated;

-- 3. Platform-only permission codes cannot be granted/revoked except by Super Admin.
create or replace function public.is_platform_permission_id(p_permission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.permissions p
    where p.id = p_permission_id
      and p.code in ('companies.manage', 'roles.manage', 'error_logs.view')
  );
$$;

revoke all on function public.is_platform_permission_id(uuid) from public;
grant execute on function public.is_platform_permission_id(uuid) to authenticated;

drop policy if exists role_permissions_mutate on public.role_permissions;

create policy role_permissions_insert on public.role_permissions
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.roles r
      where r.id = role_id
        and r.company_id is not null
        and public.has_permission(r.company_id, 'roles.manage')
    )
    and (
      (select public.is_platform_admin())
      or not public.is_platform_permission_id(permission_id)
    )
  );

create policy role_permissions_update on public.role_permissions
  for update to authenticated
  using (
    exists (
      select 1
      from public.roles r
      where r.id = role_id
        and r.company_id is not null
        and public.has_permission(r.company_id, 'roles.manage')
    )
    and (
      (select public.is_platform_admin())
      or not public.is_platform_permission_id(permission_id)
    )
  )
  with check (
    exists (
      select 1
      from public.roles r
      where r.id = role_id
        and r.company_id is not null
        and public.has_permission(r.company_id, 'roles.manage')
    )
    and (
      (select public.is_platform_admin())
      or not public.is_platform_permission_id(permission_id)
    )
  );

create policy role_permissions_delete on public.role_permissions
  for delete to authenticated
  using (
    exists (
      select 1
      from public.roles r
      where r.id = role_id
        and r.company_id is not null
        and public.has_permission(r.company_id, 'roles.manage')
    )
    and (
      (select public.is_platform_admin())
      or not public.is_platform_permission_id(permission_id)
    )
  );

-- 4. Inbox list for Super Admin filters by company + last_message_at.
create index if not exists conversations_company_last_msg_idx
  on public.conversations (company_id, last_message_at desc nulls last);
