-- Fix YCloud contact name extraction (customerProfile.name) and backfill.

create or replace function public.process_ycloud_event(
  p_event_id text,
  p_event_type text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing uuid;
  v_msg jsonb;
  v_from text;
  v_to text;
  v_body text;
  v_msg_id text;
  v_msg_type text;
  v_status text;
  v_inbox public.inboxes%rowtype;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_direction text;
  v_inbound_at timestamptz;
  v_preview text;
  v_profile_name text;
  v_contact_name text;
  v_from_user_id text;
  v_meta jsonb;
begin
  select id into v_existing from public.webhook_events where ycloud_event_id = p_event_id;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  insert into public.webhook_events (ycloud_event_id, event_type, payload)
  values (p_event_id, p_event_type, p_payload);

  if p_event_type in ('whatsapp.inbound_message.received', 'whatsapp.inbound.message') then
    v_msg := coalesce(p_payload->'whatsappInboundMessage', p_payload->'whatsappMessage');
    if v_msg is null then
      return jsonb_build_object('ok', true, 'skipped', 'no_message');
    end if;

    v_from := coalesce(v_msg->>'from', '');
    v_to := coalesce(v_msg->>'to', '');
    v_msg_id := coalesce(v_msg->>'id', v_msg->>'wamid');
    v_msg_type := coalesce(v_msg->>'type', 'text');
    v_body := coalesce(v_msg->'text'->>'body', v_msg->>'caption', '[' || v_msg_type || ']');
    v_status := coalesce(v_msg->>'status', 'received');
    v_profile_name := nullif(trim(coalesce(
      v_msg->'customerProfile'->>'name',
      v_msg->>'customerProfileName',
      ''
    )), '');
    v_contact_name := coalesce(v_profile_name, v_from);
    v_from_user_id := nullif(trim(coalesce(v_msg->>'fromUserId', '')), '');
    v_meta := case
      when v_from_user_id is not null then jsonb_build_object('ycloud_from_user_id', v_from_user_id)
      else '{}'::jsonb
    end;

    select * into v_inbox from public.inboxes
    where phone_number = v_to or phone_number = replace(v_to, '+', '')
       or regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace(v_to, '[^0-9]', '', 'g')
    limit 1;

    if v_inbox.id is null then
      return jsonb_build_object('ok', false, 'error', 'inbox_not_found', 'to', v_to);
    end if;

    insert into public.contacts (company_id, phone_number, name, metadata)
    values (v_inbox.company_id, v_from, v_contact_name, v_meta)
    on conflict (company_id, phone_number)
    do update set
      name = case
        when nullif(trim(excluded.name), '') is not null
          and excluded.name is distinct from excluded.phone_number
          and (
            public.contacts.name is null
            or public.contacts.name = ''
            or public.contacts.name = public.contacts.phone_number
          )
        then excluded.name
        else public.contacts.name
      end,
      metadata = coalesce(public.contacts.metadata, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb),
      updated_at = now()
    returning id into v_contact_id;

    v_inbound_at := coalesce((v_msg->>'createTime')::timestamptz, now());
    v_preview := left(v_body, 200);

    insert into public.conversations (
      company_id, inbox_id, contact_id, status,
      last_message_at, last_inbound_at, window_expires_at,
      last_message_preview, unread_count
    ) values (
      v_inbox.company_id, v_inbox.id, v_contact_id, 'open',
      v_inbound_at, v_inbound_at, v_inbound_at + interval '24 hours',
      v_preview, 1
    )
    on conflict (inbox_id, contact_id) do update set
      last_message_at = excluded.last_message_at,
      last_inbound_at = excluded.last_inbound_at,
      window_expires_at = excluded.window_expires_at,
      last_message_preview = excluded.last_message_preview,
      unread_count = public.conversations.unread_count + 1,
      status = case when public.conversations.status = 'closed' then 'open' else public.conversations.status end,
      updated_at = now()
    returning id into v_conversation_id;

    insert into public.messages (
      conversation_id, company_id, direction, type, body,
      ycloud_message_id, status, raw_payload
    ) values (
      v_conversation_id, v_inbox.company_id, 'inbound', v_msg_type, v_body,
      v_msg_id, v_status, v_msg
    )
    on conflict (ycloud_message_id) do update set
      status = excluded.status,
      raw_payload = excluded.raw_payload;

    if not exists (
      select 1 from public.conversation_tags ct
      join public.tags t on t.id = ct.tag_id
      where ct.conversation_id = v_conversation_id and t.is_kanban_column
    ) then
      insert into public.conversation_tags (conversation_id, tag_id)
      select v_conversation_id, t.id
      from public.tags t
      where t.company_id = v_inbox.company_id and t.is_kanban_column
      order by t.position
      limit 1
      on conflict do nothing;
    end if;

    return jsonb_build_object('ok', true, 'conversation_id', v_conversation_id);
  end if;

  if p_event_type = 'whatsapp.message.updated' then
    v_msg := p_payload->'whatsappMessage';
    if v_msg is null then
      return jsonb_build_object('ok', true, 'skipped', 'no_message');
    end if;

    v_msg_id := coalesce(v_msg->>'id', v_msg->>'wamid');
    v_status := coalesce(v_msg->>'status', 'updated');
    v_from := coalesce(v_msg->>'from', '');
    v_to := coalesce(v_msg->>'to', '');
    v_msg_type := coalesce(v_msg->>'type', 'text');
    v_body := coalesce(v_msg->'text'->>'body', v_msg->>'caption', '[' || v_msg_type || ']');

    update public.messages
    set status = v_status, raw_payload = v_msg
    where ycloud_message_id = v_msg_id;

    if found then
      return jsonb_build_object('ok', true, 'updated', true);
    end if;

    select * into v_inbox from public.inboxes
    where phone_number = v_from
       or regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace(v_from, '[^0-9]', '', 'g')
    limit 1;

    if v_inbox.id is null then
      return jsonb_build_object('ok', true, 'skipped', 'inbox_not_found');
    end if;

    v_direction := 'outbound';
    insert into public.contacts (company_id, phone_number)
    values (v_inbox.company_id, v_to)
    on conflict (company_id, phone_number) do update set updated_at = now()
    returning id into v_contact_id;

    insert into public.conversations (company_id, inbox_id, contact_id, last_message_at, last_message_preview)
    values (v_inbox.company_id, v_inbox.id, v_contact_id, coalesce((v_msg->>'createTime')::timestamptz, now()), left(v_body, 200))
    on conflict (inbox_id, contact_id) do update set
      last_message_at = greatest(public.conversations.last_message_at, excluded.last_message_at),
      last_message_preview = excluded.last_message_preview,
      updated_at = now()
    returning id into v_conversation_id;

    insert into public.messages (
      conversation_id, company_id, direction, type, body, ycloud_message_id, status, raw_payload
    ) values (
      v_conversation_id, v_inbox.company_id, v_direction, v_msg_type, v_body, v_msg_id, v_status, v_msg
    )
    on conflict (ycloud_message_id) do update set status = excluded.status, raw_payload = excluded.raw_payload;

    return jsonb_build_object('ok', true, 'conversation_id', v_conversation_id);
  end if;

  return jsonb_build_object('ok', true, 'ignored', p_event_type);
end;
$function$;

-- Backfill names from stored webhook payloads
with extracted as (
  select
    coalesce(
      payload->'whatsappInboundMessage'->>'from',
      payload->'whatsappMessage'->>'from'
    ) as phone,
    nullif(trim(coalesce(
      payload->'whatsappInboundMessage'->'customerProfile'->>'name',
      payload->'whatsappInboundMessage'->>'customerProfileName',
      payload->'whatsappMessage'->'customerProfile'->>'name',
      ''
    )), '') as profile_name,
    nullif(trim(coalesce(
      payload->'whatsappInboundMessage'->>'fromUserId',
      payload->'whatsappMessage'->>'fromUserId',
      ''
    )), '') as from_user_id,
    processed_at
  from public.webhook_events
  where event_type in (
    'whatsapp.inbound_message.received',
    'whatsapp.inbound.message'
  )
),
best as (
  select distinct on (phone)
    phone,
    profile_name,
    from_user_id
  from extracted
  where phone is not null
    and profile_name is not null
    and profile_name is distinct from phone
  order by phone, processed_at desc nulls last
)
update public.contacts c
set
  name = b.profile_name,
  metadata = coalesce(c.metadata, '{}'::jsonb)
    || case
      when b.from_user_id is not null then jsonb_build_object('ycloud_from_user_id', b.from_user_id)
      else '{}'::jsonb
    end,
  updated_at = now()
from best b
where (
  c.phone_number = b.phone
  or regexp_replace(c.phone_number, '[^0-9]', '', 'g')
     = regexp_replace(b.phone, '[^0-9]', '', 'g')
)
and (
  c.name is null
  or c.name = ''
  or c.name = c.phone_number
);
