-- Cuentas YCloud (credenciales cifradas en app) + FK en inboxes.

create table public.ycloud_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_key_encrypted text not null,
  webhook_secret_encrypted text,
  ycloud_webhook_endpoint_id text,
  api_key_last4 text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ycloud_accounts is
  'Cuentas YCloud de plataforma. api_key/webhook_secret van cifrados; solo service_role.';

alter table public.ycloud_accounts enable row level security;
revoke all on table public.ycloud_accounts from public, anon, authenticated;

alter table public.inboxes
  add column if not exists ycloud_account_id uuid references public.ycloud_accounts (id) on delete set null;

create index if not exists inboxes_ycloud_account_id_idx
  on public.inboxes (ycloud_account_id);

create unique index if not exists inboxes_account_ycloud_phone_id_uidx
  on public.inboxes (ycloud_account_id, ycloud_phone_number_id)
  where ycloud_account_id is not null and ycloud_phone_number_id is not null;

create or replace function public.process_ycloud_webhook_for_account(
  p_account_id uuid,
  p_event_id text,
  p_event_type text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_account_id is null or not exists (
    select 1
    from public.ycloud_accounts a
    where a.id = p_account_id
      and a.is_active
  ) then
    raise exception 'unknown ycloud account';
  end if;
  return public.process_ycloud_event(p_event_id, p_event_type, p_payload);
end;
$$;

revoke all on function public.process_ycloud_webhook_for_account(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_ycloud_webhook_for_account(uuid, text, text, jsonb)
  to service_role;
