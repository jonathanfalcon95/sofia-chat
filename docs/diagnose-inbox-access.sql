-- Read-only diagnosis for "a user sees no conversations". Replace the email below.
-- Run each statement in the Supabase SQL editor; nothing here writes.

-- 1. Account: expect is_active = true, a role, conversations.view, and either
--    inboxes.manage or at least one row in inbox_rows.
select
  p.id as user_id,
  p.is_platform_admin,
  m.id as membership_id,
  m.is_active,
  co.name as company,
  r.name as role,
  (select count(*) from membership_inboxes mi where mi.membership_id = m.id) as inbox_rows,
  (select array_agg(pm.code order by pm.code)
     from role_permissions rp
     join permissions pm on pm.id = rp.permission_id
    where rp.role_id = r.id
      and pm.code in ('conversations.view', 'inboxes.manage')) as key_permissions
from profiles p
left join company_memberships m on m.user_id = p.id
left join companies co on co.id = m.company_id
left join membership_roles mr on mr.membership_id = m.id
left join roles r on r.id = mr.role_id
where lower(p.email) = lower('user@example.com');

-- 2. Conversations of the user's companies, per inbox. An inbox with
--    inbox_company_matches <> true hides its conversations from everyone except
--    platform admins, and its new messages are dropped by the webhook.
select
  co.name as company,
  i.name as inbox,
  i.company_id is not distinct from c.company_id as inbox_company_matches,
  count(*) as conversations,
  max(c.last_message_at) as latest
from conversations c
join inboxes i on i.id = c.inbox_id
left join companies co on co.id = c.company_id
where c.company_id in (
  select m.company_id
  from company_memberships m
  join profiles p on p.id = m.user_id
  where lower(p.email) = lower('user@example.com')
)
group by 1, 2, 3
order by conversations desc;

-- 3. Is it a timeout? Run in Logs Explorer against postgres_logs, or check the
--    page: a timeout now shows "No se pudieron cargar las conversaciones" with a
--    retry button, while "Sin conversaciones aún" means the query really was empty.
--    select count(*) from logs
--    where source = 'postgres_logs' and event_message ilike '%statement timeout%';
