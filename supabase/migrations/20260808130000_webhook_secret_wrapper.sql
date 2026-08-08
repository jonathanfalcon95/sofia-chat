create table if not exists public.app_secrets (
  key text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on table public.app_secrets from anon, authenticated;

create or replace function public.process_ycloud_webhook(
  p_secret text,
  p_event_id text,
  p_event_type text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_secrets where key = 'ycloud_webhook_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    raise exception 'invalid webhook secret';
  end if;
  return public.process_ycloud_event(p_event_id, p_event_type, p_payload);
end;
$$;

revoke all on function public.process_ycloud_webhook(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.process_ycloud_webhook(text, text, text, jsonb) to anon, authenticated, service_role;
