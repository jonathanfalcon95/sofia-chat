-- Pool global de inboxes (company_id nullable) + guid_company en empresas.

alter table public.companies
  add column if not exists guid_company text;

alter table public.inboxes
  alter column company_id drop not null;

alter table public.inboxes
  drop constraint if exists inboxes_company_id_fkey;

alter table public.inboxes
  add constraint inboxes_company_id_fkey
  foreign key (company_id)
  references public.companies (id)
  on delete set null;

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
        and i.company_id is not null
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

drop policy if exists inboxes_select on public.inboxes;
create policy inboxes_select on public.inboxes for select to authenticated
  using (
    public.is_platform_admin()
    or (
      company_id is not null
      and (
        public.has_inbox_access(id)
        or public.has_permission(company_id, 'inboxes.manage')
      )
    )
  );

drop policy if exists inboxes_insert on public.inboxes;
create policy inboxes_insert on public.inboxes for insert to authenticated
  with check (
    public.is_platform_admin()
    or (
      company_id is not null
      and public.has_permission(company_id, 'inboxes.manage')
    )
  );

drop policy if exists inboxes_update on public.inboxes;
create policy inboxes_update on public.inboxes for update to authenticated
  using (
    public.is_platform_admin()
    or (
      company_id is not null
      and public.has_permission(company_id, 'inboxes.manage')
    )
  )
  with check (
    public.is_platform_admin()
    or (
      company_id is not null
      and public.has_permission(company_id, 'inboxes.manage')
    )
  );

drop policy if exists inboxes_delete on public.inboxes;
create policy inboxes_delete on public.inboxes for delete to authenticated
  using (
    public.is_platform_admin()
    or (
      company_id is not null
      and public.has_permission(company_id, 'inboxes.manage')
    )
  );
