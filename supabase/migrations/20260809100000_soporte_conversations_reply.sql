insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.name = 'Soporte'
  and p.code in ('conversations.reply', 'templates.send')
on conflict do nothing;
