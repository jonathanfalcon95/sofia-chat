-- Permission for agents to create/edit/delete contact tags (non-kanban)

insert into public.permissions (code, description)
values ('tags.manage', 'Crear y gestionar tags de contacto')
on conflict (code) do update set description = excluded.description;

-- Admin (all company + template): already gets all except companies.manage via seed pattern
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'Admin'
  and p.code = 'tags.manage'
on conflict do nothing;

-- Agente can manage contact tags for their company
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'Agente'
  and p.code = 'tags.manage'
on conflict do nothing;

-- RLS: tags.manage can mutate only non-kanban tags; kanban stays for managers
drop policy if exists tags_mutate on public.tags;
create policy tags_mutate on public.tags for all to authenticated
  using (
    public.has_permission(company_id, 'kanban.manage')
    or public.has_permission(company_id, 'inboxes.manage')
    or (
      public.has_permission(company_id, 'tags.manage')
      and is_kanban_column = false
    )
  )
  with check (
    public.has_permission(company_id, 'kanban.manage')
    or public.has_permission(company_id, 'inboxes.manage')
    or (
      public.has_permission(company_id, 'tags.manage')
      and is_kanban_column = false
    )
  );
