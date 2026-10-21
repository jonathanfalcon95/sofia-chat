-- Compact coexistence fix (applyable via MCP):
-- 1) Remap WhatsApp Business App echo events to outbound handler
-- 2) BEFORE INSERT trigger sets created_at from sendTime for app outbound
-- 3) Backfill Storeclick + Famcos messages skipped while inbox was missing

create or replace function public.messages_apply_send_time()
returns trigger
language plpgsql
as $$
declare
  v_send timestamptz;
begin
  if new.direction = 'outbound' and new.sent_by is null and new.raw_payload is not null then
    begin
      v_send := nullif(new.raw_payload->>'sendTime', '')::timestamptz;
    exception when others then
      v_send := null;
    end;
    if v_send is null then
      begin
        v_send := nullif(new.raw_payload->>'createTime', '')::timestamptz;
      exception when others then
        v_send := null;
      end;
    end if;
    if v_send is not null then
      new.created_at := v_send;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_apply_send_time_trg on public.messages;
create trigger messages_apply_send_time_trg
  before insert on public.messages
  for each row
  execute function public.messages_apply_send_time();

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
declare
  v_type text := p_event_type;
begin
  if p_account_id is null or not exists (
    select 1
    from public.ycloud_accounts a
    where a.id = p_account_id
      and a.is_active
  ) then
    raise exception 'unknown ycloud account';
  end if;

  -- Coexistence: Business App sends arrive as smb echoes; reuse outbound insert path.
  if p_event_type in (
    'whatsapp.smb.message.echoes',
    'whatsapp.smb.message.created'
  ) then
    v_type := 'whatsapp.message.updated';
  end if;

  return public.process_ycloud_event(p_event_id, v_type, p_payload);
end;
$$;

revoke all on function public.process_ycloud_webhook_for_account(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_ycloud_webhook_for_account(uuid, text, text, jsonb)
  to service_role;

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
  v_type text := p_event_type;
begin
  select value into v_secret from public.app_secrets where key = 'ycloud_webhook_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    raise exception 'invalid webhook secret';
  end if;

  if p_event_type in (
    'whatsapp.smb.message.echoes',
    'whatsapp.smb.message.created'
  ) then
    v_type := 'whatsapp.message.updated';
  end if;

  return public.process_ycloud_event(p_event_id, v_type, p_payload);
end;
$$;

revoke all on function public.process_ycloud_webhook(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_ycloud_webhook(text, text, text, jsonb)
  to anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Backfill: Storeclick + Famcos messages skipped while inbox was missing
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_inbox public.inboxes%rowtype;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_body text;
  v_msg jsonb;
  v_msg_type text;
  v_media jsonb;
  v_media_url text;
  v_media_mime text;
  v_media_filename text;
  v_media_sha256 text;
  v_sent_at timestamptz;
  v_reply_to text;
  v_wamid text;
  v_status text;
  v_digits text;
begin
  for r in
    with ranked as (
      select
        we.payload->'whatsappMessage' as msg,
        we.payload->'whatsappMessage'->>'id' as yid,
        we.payload->'whatsappMessage'->>'from' as from_phone,
        we.payload->'whatsappMessage'->>'to' as to_phone,
        we.processed_at,
        row_number() over (
          partition by we.payload->'whatsappMessage'->>'id'
          order by
            case we.payload->'whatsappMessage'->>'status'
              when 'read' then 3
              when 'delivered' then 2
              when 'sent' then 1
              else 0
            end desc,
            we.processed_at desc
        ) as rn
      from public.webhook_events we
      where we.event_type = 'whatsapp.message.updated'
        and coalesce(we.payload->'whatsappMessage'->>'type', '') <> 'reaction'
        and regexp_replace(coalesce(we.payload->'whatsappMessage'->>'from', ''), '[^0-9]', '', 'g')
            in ('584226601262', '584122707134')
        and nullif(we.payload->'whatsappMessage'->>'id', '') is not null
        and not exists (
          select 1 from public.messages m
          where m.ycloud_message_id = we.payload->'whatsappMessage'->>'id'
             or (
               nullif(we.payload->'whatsappMessage'->>'wamid', '') is not null
               and m.wamid = we.payload->'whatsappMessage'->>'wamid'
             )
        )
    )
    select * from ranked where rn = 1
  loop
    v_msg := r.msg;
    v_digits := regexp_replace(r.from_phone, '[^0-9]', '', 'g');
    select * into v_inbox from public.inboxes
    where regexp_replace(phone_number, '[^0-9]', '', 'g') = v_digits
    limit 1;
    if v_inbox.id is null or v_inbox.company_id is null then
      continue;
    end if;

    v_msg_type := coalesce(v_msg->>'type', 'text');
    v_status := coalesce(v_msg->>'status', 'sent');
    v_wamid := nullif(v_msg->>'wamid', '');
    v_reply_to := coalesce(
      nullif(v_msg->'context'->>'message_id', ''),
      nullif(v_msg->'context'->>'id', ''),
      nullif(v_msg->'context'->>'wamid', '')
    );
    v_sent_at := coalesce(
      nullif(v_msg->>'sendTime', '')::timestamptz,
      nullif(v_msg->>'createTime', '')::timestamptz,
      r.processed_at,
      now()
    );
    v_media_url := null;
    v_media_mime := null;
    v_media_filename := null;
    v_media_sha256 := null;

    if v_msg_type in ('image', 'audio', 'video', 'document', 'sticker') then
      v_media := v_msg->v_msg_type;
      if v_media is not null and jsonb_typeof(v_media) = 'object' then
        v_media_url := nullif(v_media->>'link', '');
        v_media_mime := coalesce(nullif(v_media->>'mime_type', ''), nullif(v_media->>'mimeType', ''));
        v_media_filename := nullif(v_media->>'filename', '');
        v_media_sha256 := nullif(v_media->>'sha256', '');
        v_body := coalesce(
          nullif(v_media->>'caption', ''),
          v_media_filename,
          case v_msg_type
            when 'audio' then 'Nota de voz'
            when 'image' then 'Imagen'
            when 'video' then 'Video'
            when 'sticker' then 'Sticker'
            when 'document' then 'Documento'
            else '[' || v_msg_type || ']'
          end
        );
      else
        v_body := case v_msg_type
          when 'audio' then 'Nota de voz'
          when 'image' then 'Imagen'
          when 'video' then 'Video'
          when 'sticker' then 'Sticker'
          when 'document' then 'Documento'
          else '[' || v_msg_type || ']'
        end;
      end if;
    else
      v_body := coalesce(v_msg->'text'->>'body', v_msg->>'caption', '[' || v_msg_type || ']');
    end if;

    insert into public.contacts (company_id, phone_number)
    values (v_inbox.company_id, r.to_phone)
    on conflict (company_id, phone_number) do update set updated_at = now()
    returning id into v_contact_id;

    if v_contact_id is null then
      select id into v_contact_id from public.contacts
      where company_id = v_inbox.company_id and phone_number = r.to_phone;
    end if;

    insert into public.conversations (company_id, inbox_id, contact_id, last_message_at, last_message_preview)
    values (v_inbox.company_id, v_inbox.id, v_contact_id, v_sent_at, left(v_body, 200))
    on conflict (inbox_id, contact_id) do update set
      last_message_at = greatest(public.conversations.last_message_at, excluded.last_message_at),
      last_message_preview = case
        when excluded.last_message_at >= coalesce(public.conversations.last_message_at, '-infinity'::timestamptz)
        then excluded.last_message_preview
        else public.conversations.last_message_preview
      end,
      updated_at = now()
    returning id into v_conversation_id;

    if v_conversation_id is null then
      select id into v_conversation_id from public.conversations
      where inbox_id = v_inbox.id and contact_id = v_contact_id;
    end if;

    insert into public.messages (
      conversation_id, company_id, direction, type, body, ycloud_message_id, wamid, reply_to_wamid,
      status, raw_payload, media_url, media_mime, media_filename, media_sha256, created_at
    ) values (
      v_conversation_id, v_inbox.company_id, 'outbound', v_msg_type, v_body, r.yid, v_wamid, v_reply_to,
      v_status, v_msg, v_media_url, v_media_mime, v_media_filename, v_media_sha256, v_sent_at
    )
    on conflict (ycloud_message_id) do nothing;
  end loop;

  -- Inbound backfill (Storeclick + Famcos) for events before inbox existed
  for r in
    with ranked as (
      select
        coalesce(we.payload->'whatsappInboundMessage', we.payload->'whatsappMessage') as msg,
        coalesce(
          we.payload->'whatsappInboundMessage'->>'id',
          we.payload->'whatsappMessage'->>'id'
        ) as yid,
        coalesce(
          we.payload->'whatsappInboundMessage'->>'from',
          we.payload->'whatsappMessage'->>'from'
        ) as from_phone,
        coalesce(
          we.payload->'whatsappInboundMessage'->>'to',
          we.payload->'whatsappMessage'->>'to'
        ) as to_phone,
        we.processed_at,
        row_number() over (
          partition by coalesce(
            we.payload->'whatsappInboundMessage'->>'id',
            we.payload->'whatsappMessage'->>'id'
          )
          order by we.processed_at desc
        ) as rn
      from public.webhook_events we
      where we.event_type in ('whatsapp.inbound_message.received', 'whatsapp.inbound.message')
        and regexp_replace(
          coalesce(
            we.payload->'whatsappInboundMessage'->>'to',
            we.payload->'whatsappMessage'->>'to',
            ''
          ),
          '[^0-9]', '', 'g'
        ) in ('584226601262', '584122707134')
        and coalesce(
          we.payload->'whatsappInboundMessage'->>'type',
          we.payload->'whatsappMessage'->>'type',
          ''
        ) not in ('reaction')
        and nullif(coalesce(
          we.payload->'whatsappInboundMessage'->>'id',
          we.payload->'whatsappMessage'->>'id'
        ), '') is not null
        and not exists (
          select 1 from public.messages m
          where m.ycloud_message_id = coalesce(
            we.payload->'whatsappInboundMessage'->>'id',
            we.payload->'whatsappMessage'->>'id'
          )
             or (
               nullif(coalesce(
                 we.payload->'whatsappInboundMessage'->>'wamid',
                 we.payload->'whatsappMessage'->>'wamid'
               ), '') is not null
               and m.wamid = coalesce(
                 we.payload->'whatsappInboundMessage'->>'wamid',
                 we.payload->'whatsappMessage'->>'wamid'
               )
             )
        )
    )
    select * from ranked where rn = 1
  loop
    v_msg := r.msg;
    v_digits := regexp_replace(r.to_phone, '[^0-9]', '', 'g');
    select * into v_inbox from public.inboxes
    where regexp_replace(phone_number, '[^0-9]', '', 'g') = v_digits
    limit 1;
    if v_inbox.id is null or v_inbox.company_id is null then
      continue;
    end if;

    v_msg_type := coalesce(v_msg->>'type', 'text');
    v_status := coalesce(v_msg->>'status', 'received');
    v_wamid := nullif(v_msg->>'wamid', '');
    v_reply_to := coalesce(
      nullif(v_msg->'context'->>'message_id', ''),
      nullif(v_msg->'context'->>'id', ''),
      nullif(v_msg->'context'->>'wamid', '')
    );
    v_sent_at := coalesce(
      nullif(v_msg->>'sendTime', '')::timestamptz,
      nullif(v_msg->>'createTime', '')::timestamptz,
      r.processed_at,
      now()
    );
    v_media_url := null;
    v_media_mime := null;
    v_media_filename := null;
    v_media_sha256 := null;

    if v_msg_type in ('image', 'audio', 'video', 'document', 'sticker') then
      v_media := v_msg->v_msg_type;
      if v_media is not null and jsonb_typeof(v_media) = 'object' then
        v_media_url := nullif(v_media->>'link', '');
        v_media_mime := coalesce(nullif(v_media->>'mime_type', ''), nullif(v_media->>'mimeType', ''));
        v_media_filename := nullif(v_media->>'filename', '');
        v_media_sha256 := nullif(v_media->>'sha256', '');
        v_body := coalesce(
          nullif(v_media->>'caption', ''),
          v_media_filename,
          case v_msg_type
            when 'audio' then 'Nota de voz'
            when 'image' then 'Imagen'
            when 'video' then 'Video'
            when 'sticker' then 'Sticker'
            when 'document' then 'Documento'
            else '[' || v_msg_type || ']'
          end
        );
      else
        v_body := case v_msg_type
          when 'audio' then 'Nota de voz'
          when 'image' then 'Imagen'
          when 'video' then 'Video'
          when 'sticker' then 'Sticker'
          when 'document' then 'Documento'
          else '[' || v_msg_type || ']'
        end;
      end if;
    elsif v_msg_type = 'location' then
      v_body := coalesce(
        nullif(trim(concat_ws(E'\n',
          nullif(v_msg->'location'->>'name', ''),
          nullif(v_msg->'location'->>'address', '')
        )), ''),
        '📍 Ubicación compartida'
      );
    else
      v_body := coalesce(v_msg->'text'->>'body', v_msg->>'caption', '[' || v_msg_type || ']');
    end if;

    insert into public.contacts (company_id, phone_number, name)
    values (
      v_inbox.company_id,
      r.from_phone,
      coalesce(nullif(trim(v_msg->'customerProfile'->>'name'), ''), r.from_phone)
    )
    on conflict (company_id, phone_number) do update set
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
      updated_at = now()
    returning id into v_contact_id;

    if v_contact_id is null then
      select id into v_contact_id from public.contacts
      where company_id = v_inbox.company_id and phone_number = r.from_phone;
    end if;

    insert into public.conversations (
      company_id, inbox_id, contact_id, status,
      last_message_at, last_inbound_at, window_expires_at, last_message_preview, unread_count
    ) values (
      v_inbox.company_id, v_inbox.id, v_contact_id, 'open',
      v_sent_at, v_sent_at, v_sent_at + interval '24 hours', left(v_body, 200), 0
    )
    on conflict (inbox_id, contact_id) do update set
      last_message_at = greatest(public.conversations.last_message_at, excluded.last_message_at),
      last_inbound_at = greatest(public.conversations.last_inbound_at, excluded.last_inbound_at),
      window_expires_at = greatest(public.conversations.window_expires_at, excluded.window_expires_at),
      last_message_preview = case
        when excluded.last_message_at >= coalesce(public.conversations.last_message_at, '-infinity'::timestamptz)
        then excluded.last_message_preview
        else public.conversations.last_message_preview
      end,
      updated_at = now()
    returning id into v_conversation_id;

    if v_conversation_id is null then
      select id into v_conversation_id from public.conversations
      where inbox_id = v_inbox.id and contact_id = v_contact_id;
    end if;

    insert into public.messages (
      conversation_id, company_id, direction, type, body, ycloud_message_id, wamid, reply_to_wamid,
      status, raw_payload, media_url, media_mime, media_filename, media_sha256, created_at
    ) values (
      v_conversation_id, v_inbox.company_id, 'inbound', v_msg_type, v_body, r.yid, v_wamid, v_reply_to,
      v_status, v_msg, v_media_url, v_media_mime, v_media_filename, v_media_sha256, v_sent_at
    )
    on conflict (ycloud_message_id) do nothing;
  end loop;
end $$;

-- Fix created_at on existing app-originated outbound (webhook time vs sendTime)
update public.messages m
set created_at = (m.raw_payload->>'sendTime')::timestamptz
where m.direction = 'outbound'
  and m.sent_by is null
  and nullif(m.raw_payload->>'sendTime', '') is not null
  and abs(extract(epoch from (m.created_at - (m.raw_payload->>'sendTime')::timestamptz))) > 5
  and m.company_id in (
    select company_id from public.inboxes
    where regexp_replace(phone_number, '[^0-9]', '', 'g') in ('584226601262', '584122707134')
  );

drop table if exists public._tmp_mig_sql;

