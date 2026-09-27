-- Fix outbound message display in whatsapp.message.updated and backfill placeholders.
-- 1. Updates public.process_ycloud_event to properly format body, media columns, and preserve raw_payload on both INSERT and UPDATE.
-- 2. Backfills messages (interactive, media, location, contacts, order, and generic bracket placeholders).
-- 3. Synchronizes conversations.last_message_preview for all conversations whose preview was a placeholder.

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
  v_content_msg jsonb;
  v_from text;
  v_to text;
  v_body text;
  v_msg_id text;
  v_wamid text;
  v_reply_to text;
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
  v_media jsonb;
  v_media_url text;
  v_media_mime text;
  v_media_filename text;
  v_media_sha256 text;
  v_reaction_target text;
  v_reaction_emoji text;
  v_target_id uuid;
  v_edit jsonb;
  v_orig_wamid text;
  v_edited_msg jsonb;
  v_system jsonb;
  v_new_phone text;
  v_interactive jsonb;
  v_url text;
  v_display text;
  v_contact_elem jsonb;
  v_contact_line text;
  v_phone_elem jsonb;
  v_loc jsonb;
  v_loc_name text;
  v_loc_addr text;
  v_lat text;
  v_lng text;
  v_order jsonb;
  v_items_count int;
  v_order_text text;
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
    v_wamid := coalesce(nullif(v_msg->>'wamid', ''), case when v_msg_id like 'wamid.%' then v_msg_id else null end);
    v_msg_type := coalesce(v_msg->>'type', 'text');
    v_status := coalesce(v_msg->>'status', 'received');
    v_reply_to := coalesce(
      nullif(v_msg->'context'->>'message_id', ''),
      nullif(v_msg->'context'->>'id', ''),
      nullif(v_msg->'context'->>'wamid', '')
    );

    select * into v_inbox from public.inboxes
    where phone_number = v_to or phone_number = replace(v_to, '+', '')
       or regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace(v_to, '[^0-9]', '', 'g')
    limit 1;

    if v_inbox.id is null then
      return jsonb_build_object('ok', true, 'skipped', 'inbox_not_found');
    end if;

    if v_inbox.company_id is null then
      return jsonb_build_object('ok', true, 'skipped', 'inbox_unassigned');
    end if;

    if v_msg_type = 'reaction' then
      v_reaction_target := coalesce(
        nullif(v_msg->'reaction'->>'message_id', ''),
        nullif(v_msg->'reaction'->>'wamid', ''),
        v_reply_to
      );
      v_reaction_emoji := coalesce(v_msg->'reaction'->>'emoji', '');

      if v_reaction_target is null then
        return jsonb_build_object('ok', true, 'skipped', 'reaction_missing_target');
      end if;

      select id into v_target_id
      from public.messages
      where company_id = v_inbox.company_id
        and (wamid = v_reaction_target or ycloud_message_id = v_reaction_target)
      order by created_at desc
      limit 1;

      if v_target_id is null then
        return jsonb_build_object('ok', true, 'skipped', 'reaction_target_not_found');
      end if;

      update public.messages
      set reactions = (
        select coalesce(jsonb_agg(elem), '[]'::jsonb)
        from jsonb_array_elements(
          case
            when jsonb_typeof(coalesce(reactions, '[]'::jsonb)) = 'array'
            then coalesce(reactions, '[]'::jsonb)
            else '[]'::jsonb
          end
        ) elem
        where not (
          elem->>'direction' = 'inbound'
          and (
            elem->>'from' is not distinct from v_from
            or regexp_replace(coalesce(elem->>'from', ''), '[^0-9]', '', 'g')
               = regexp_replace(v_from, '[^0-9]', '', 'g')
          )
        )
      ) || case
        when v_reaction_emoji = '' then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object(
          'emoji', v_reaction_emoji,
          'from', v_from,
          'direction', 'inbound'
        ))
      end
      where id = v_target_id;

      return jsonb_build_object('ok', true, 'reaction', true, 'message_id', v_target_id);
    end if;

    if v_msg_type = 'revoke' then
      v_orig_wamid := coalesce(
        nullif(v_msg->'revoke'->>'message_id', ''),
        nullif(v_msg->'revoke'->>'wamid', ''),
        v_reply_to
      );
      if v_orig_wamid is not null then
        update public.messages
        set body = 'Mensaje eliminado',
            media_url = null,
            media_mime = null,
            media_filename = null,
            media_sha256 = null,
            raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object('revoked_at', now(), 'revoke_event', v_msg)
        where company_id = v_inbox.company_id
          and (wamid = v_orig_wamid or ycloud_message_id = v_orig_wamid);
      end if;
      return jsonb_build_object('ok', true, 'revoked', v_orig_wamid);
    end if;

    v_content_msg := v_msg;
    v_body := null;

    if v_msg_type = 'edit' then
      v_edit := v_msg->'edit';
      v_orig_wamid := coalesce(
        nullif(v_edit->>'message_id', ''),
        nullif(v_edit->>'wamid', ''),
        v_reply_to
      );
      v_edited_msg := v_edit->'message';
      if v_edited_msg is not null and jsonb_typeof(v_edited_msg) = 'object' then
        v_content_msg := v_edited_msg;
        v_msg_type := coalesce(v_edited_msg->>'type', 'text');
        v_body := null;
      else
        v_content_msg := v_msg;
        v_msg_type := 'text';
        v_body := 'Mensaje editado';
      end if;
    end if;

    if v_msg_type = 'interactive' then
      v_interactive := v_content_msg->'interactive';
      v_body := coalesce(nullif(trim(v_interactive->'body'->>'text'), ''), '');
      v_url := nullif(v_interactive->'action'->'parameters'->>'url', '');
      v_display := coalesce(
        nullif(trim(v_interactive->'action'->'parameters'->>'display_text'), ''),
        'Abrir enlace'
      );
      if v_body <> '' and v_url is not null then
        v_body := v_body || E'\n' || v_display || ': ' || v_url;
      elsif v_body = '' and v_url is not null then
        v_body := v_display || ': ' || v_url;
      elsif v_body = '' then
        v_body := 'Mensaje interactivo';
      end if;
    elsif v_msg_type = 'contacts' then
      v_body := '';
      for v_contact_elem in
        select value from jsonb_array_elements(coalesce(v_content_msg->'contacts', '[]'::jsonb))
      loop
        v_contact_line := coalesce(
          nullif(trim(v_contact_elem->'name'->>'formatted_name'), ''),
          nullif(trim(concat_ws(' ',
            nullif(v_contact_elem->'name'->>'first_name', ''),
            nullif(v_contact_elem->'name'->>'middle_name', ''),
            nullif(v_contact_elem->'name'->>'last_name', '')
          )), ''),
          'Contacto'
        );
        v_body := case
          when v_body = '' then v_contact_line
          else v_body || E'\n' || v_contact_line
        end;
        for v_phone_elem in
          select value from jsonb_array_elements(coalesce(v_contact_elem->'phones', '[]'::jsonb))
        loop
          v_contact_line := coalesce(
            nullif(v_phone_elem->>'phone', ''),
            nullif(v_phone_elem->>'wa_id', '')
          );
          if v_contact_line is not null then
            if nullif(v_phone_elem->>'type', '') is not null then
              v_contact_line := v_phone_elem->>'type' || ': ' || v_contact_line;
            end if;
            v_body := v_body || E'\n' || v_contact_line;
          end if;
        end loop;
      end loop;
      if coalesce(v_body, '') = '' then
        v_body := 'Contacto compartido';
      end if;
    elsif v_msg_type = 'location' then
      v_loc := v_content_msg->'location';
      v_loc_name := nullif(trim(v_loc->>'name'), '');
      v_loc_addr := nullif(trim(v_loc->>'address'), '');
      v_lat := nullif(trim(v_loc->>'latitude'), '');
      v_lng := nullif(trim(v_loc->>'longitude'), '');
      v_body := coalesce(
        case
          when v_loc_name is not null and v_loc_addr is not null then '📍 ' || v_loc_name || E'\n' || v_loc_addr
          when v_loc_name is not null then '📍 ' || v_loc_name
          when v_loc_addr is not null then '📍 ' || v_loc_addr
          when v_lat is not null and v_lng is not null then '📍 Ubicación: ' || v_lat || ', ' || v_lng
          else null
        end,
        '📍 Ubicación compartida'
      );
    elsif v_msg_type = 'order' then
      v_order := v_content_msg->'order';
      v_items_count := coalesce(jsonb_array_length(v_order->'product_items'), 0);
      v_order_text := nullif(trim(v_order->>'text'), '');
      v_body := coalesce(
        v_order_text,
        case
          when v_items_count > 0 then '🛒 Pedido de catálogo (' || v_items_count || ' artículo' || case when v_items_count > 1 then 's' else '' end || ')'
          else '🛒 Pedido de catálogo'
        end
      );
    elsif v_msg_type = 'system' then
      v_system := v_content_msg->'system';
      if coalesce(v_system->>'type', '') = 'user_changed_number'
        and nullif(v_system->>'wa_id', '') is not null
      then
        v_body := 'El contacto cambió de número a +' || regexp_replace(v_system->>'wa_id', '^\+', '');
      else
        v_body := coalesce(
          nullif(v_system->>'body', ''),
          'Mensaje del sistema de WhatsApp'
        );
      end if;
    elsif v_msg_type = 'unsupported' then
      v_body := 'WhatsApp no compartió este mensaje (tipo no disponible para negocios).';
    end if;

    if v_body is null then
      v_media := null;
      v_media_url := null;
      v_media_mime := null;
      v_media_filename := null;
      v_media_sha256 := null;

      if v_msg_type in ('image', 'audio', 'video', 'document', 'sticker') then
        v_media := v_content_msg->v_msg_type;
        if v_media is not null and jsonb_typeof(v_media) = 'object' then
          v_media_url := nullif(v_media->>'link', '');
          v_media_mime := coalesce(
            nullif(v_media->>'mime_type', ''),
            nullif(v_media->>'mimeType', '')
          );
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
        v_body := coalesce(
          v_content_msg->'text'->>'body',
          v_content_msg->>'caption',
          '[' || v_msg_type || ']'
        );
      end if;
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

    if v_msg_type = 'system' then
      v_system := v_content_msg->'system';
      if coalesce(v_system->>'type', '') = 'user_changed_number'
        and nullif(v_system->>'wa_id', '') is not null
      then
        v_new_phone := '+' || regexp_replace(v_system->>'wa_id', '^\+', '');
        begin
          update public.contacts
          set phone_number = v_new_phone, updated_at = now()
          where company_id = v_inbox.company_id
            and phone_number = v_from;
        exception
          when unique_violation then
            null;
        end;
      end if;
    end if;

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
      ycloud_message_id, wamid, reply_to_wamid, status, raw_payload,
      media_url, media_mime, media_filename, media_sha256
    ) values (
      v_conversation_id, v_inbox.company_id, 'inbound', v_msg_type, v_body,
      v_msg_id, v_wamid, v_reply_to, v_status, v_msg,
      v_media_url, v_media_mime, v_media_filename, v_media_sha256
    )
    on conflict (ycloud_message_id) do update set
      status = excluded.status,
      raw_payload = excluded.raw_payload,
      wamid = coalesce(excluded.wamid, public.messages.wamid),
      reply_to_wamid = coalesce(excluded.reply_to_wamid, public.messages.reply_to_wamid),
      media_url = coalesce(excluded.media_url, public.messages.media_url),
      media_mime = coalesce(excluded.media_mime, public.messages.media_mime),
      media_filename = coalesce(excluded.media_filename, public.messages.media_filename),
      media_sha256 = coalesce(excluded.media_sha256, public.messages.media_sha256),
      body = case
        when public.messages.body is null
          or public.messages.body ~ '^\[[a-z_]+\]$'
        then excluded.body
        else public.messages.body
      end,
      type = excluded.type;

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
    v_wamid := coalesce(nullif(v_msg->>'wamid', ''), case when v_msg_id like 'wamid.%' then v_msg_id else null end);
    v_status := coalesce(v_msg->>'status', 'updated');
    v_from := coalesce(v_msg->>'from', '');
    v_to := coalesce(v_msg->>'to', '');
    v_msg_type := coalesce(v_msg->>'type', 'text');
    v_content_msg := v_msg;
    v_body := null;
    v_media := null;
    v_media_url := null;
    v_media_mime := null;
    v_media_filename := null;
    v_media_sha256 := null;

    v_reply_to := coalesce(
      nullif(v_msg->'context'->>'message_id', ''),
      nullif(v_msg->'context'->>'id', ''),
      nullif(v_msg->'context'->>'wamid', '')
    );

    if v_msg_type = 'reaction' then
      v_reaction_target := coalesce(
        nullif(v_msg->'reaction'->>'message_id', ''),
        nullif(v_msg->'reaction'->>'wamid', ''),
        v_reply_to
      );
      v_reaction_emoji := coalesce(v_msg->'reaction'->>'emoji', '');

      select * into v_inbox from public.inboxes
      where phone_number = v_from or phone_number = replace(v_from, '+', '')
         or regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace(v_from, '[^0-9]', '', 'g')
      limit 1;

      if v_inbox.id is null then
        return jsonb_build_object('ok', true, 'skipped', 'reaction_inbox_not_found');
      end if;

      if v_inbox.company_id is null then
        return jsonb_build_object('ok', true, 'skipped', 'inbox_unassigned');
      end if;

      if v_reaction_target is null then
        return jsonb_build_object('ok', true, 'skipped', 'reaction_missing_target');
      end if;

      select id into v_target_id
      from public.messages
      where company_id = v_inbox.company_id
        and (wamid = v_reaction_target or ycloud_message_id = v_reaction_target)
      order by created_at desc
      limit 1;

      if v_target_id is null then
        return jsonb_build_object('ok', true, 'skipped', 'reaction_target_not_found');
      end if;

      update public.messages
      set reactions = (
        select coalesce(jsonb_agg(elem), '[]'::jsonb)
        from jsonb_array_elements(
          case
            when jsonb_typeof(coalesce(reactions, '[]'::jsonb)) = 'array'
            then coalesce(reactions, '[]'::jsonb)
            else '[]'::jsonb
          end
        ) elem
        where not (
          elem->>'direction' = 'outbound'
          and (
            elem->>'from' is not distinct from v_from
            or regexp_replace(coalesce(elem->>'from', ''), '[^0-9]', '', 'g')
               = regexp_replace(v_from, '[^0-9]', '', 'g')
          )
        )
      ) || case
        when v_reaction_emoji = '' then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object(
          'emoji', v_reaction_emoji,
          'from', v_from,
          'direction', 'outbound'
        ))
      end
      where id = v_target_id;

      return jsonb_build_object('ok', true, 'reaction', true, 'direction', 'outbound', 'message_id', v_target_id);
    end if;

    -- Format rich content for outbound messages
    if v_msg_type = 'interactive' then
      v_interactive := v_content_msg->'interactive';
      v_body := coalesce(nullif(trim(v_interactive->'body'->>'text'), ''), '');
      v_url := nullif(v_interactive->'action'->'parameters'->>'url', '');
      v_display := coalesce(
        nullif(trim(v_interactive->'action'->'parameters'->>'display_text'), ''),
        'Abrir enlace'
      );
      if v_body <> '' and v_url is not null then
        v_body := v_body || E'\n' || v_display || ': ' || v_url;
      elsif v_body = '' and v_url is not null then
        v_body := v_display || ': ' || v_url;
      elsif v_body = '' then
        v_body := 'Mensaje interactivo';
      end if;
    elsif v_msg_type = 'contacts' then
      v_body := '';
      for v_contact_elem in
        select value from jsonb_array_elements(coalesce(v_content_msg->'contacts', '[]'::jsonb))
      loop
        v_contact_line := coalesce(
          nullif(trim(v_contact_elem->'name'->>'formatted_name'), ''),
          nullif(trim(concat_ws(' ',
            nullif(v_contact_elem->'name'->>'first_name', ''),
            nullif(v_contact_elem->'name'->>'middle_name', ''),
            nullif(v_contact_elem->'name'->>'last_name', '')
          )), ''),
          'Contacto'
        );
        v_body := case
          when v_body = '' then v_contact_line
          else v_body || E'\n' || v_contact_line
        end;
        for v_phone_elem in
          select value from jsonb_array_elements(coalesce(v_contact_elem->'phones', '[]'::jsonb))
        loop
          v_contact_line := coalesce(
            nullif(v_phone_elem->>'phone', ''),
            nullif(v_phone_elem->>'wa_id', '')
          );
          if v_contact_line is not null then
            if nullif(v_phone_elem->>'type', '') is not null then
              v_contact_line := v_phone_elem->>'type' || ': ' || v_contact_line;
            end if;
            v_body := v_body || E'\n' || v_contact_line;
          end if;
        end loop;
      end loop;
      if coalesce(v_body, '') = '' then
        v_body := 'Contacto compartido';
      end if;
    elsif v_msg_type = 'location' then
      v_loc := v_content_msg->'location';
      v_loc_name := nullif(trim(v_loc->>'name'), '');
      v_loc_addr := nullif(trim(v_loc->>'address'), '');
      v_lat := nullif(trim(v_loc->>'latitude'), '');
      v_lng := nullif(trim(v_loc->>'longitude'), '');
      v_body := coalesce(
        case
          when v_loc_name is not null and v_loc_addr is not null then '📍 ' || v_loc_name || E'\n' || v_loc_addr
          when v_loc_name is not null then '📍 ' || v_loc_name
          when v_loc_addr is not null then '📍 ' || v_loc_addr
          when v_lat is not null and v_lng is not null then '📍 Ubicación: ' || v_lat || ', ' || v_lng
          else null
        end,
        '📍 Ubicación compartida'
      );
    elsif v_msg_type = 'order' then
      v_order := v_content_msg->'order';
      v_items_count := coalesce(jsonb_array_length(v_order->'product_items'), 0);
      v_order_text := nullif(trim(v_order->>'text'), '');
      v_body := coalesce(
        v_order_text,
        case
          when v_items_count > 0 then '🛒 Pedido de catálogo (' || v_items_count || ' artículo' || case when v_items_count > 1 then 's' else '' end || ')'
          else '🛒 Pedido de catálogo'
        end
      );
    end if;

    if v_body is null then
      if v_msg_type in ('image', 'audio', 'video', 'document', 'sticker') then
        v_media := v_content_msg->v_msg_type;
        if v_media is not null and jsonb_typeof(v_media) = 'object' then
          v_media_url := nullif(v_media->>'link', '');
          v_media_mime := coalesce(
            nullif(v_media->>'mime_type', ''),
            nullif(v_media->>'mimeType', '')
          );
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
        v_body := coalesce(
          v_content_msg->'text'->>'body',
          v_content_msg->>'caption',
          '[' || v_msg_type || ']'
        );
      end if;
    end if;

    -- Update existing message: preserve rich payload blocks, update media & body
    update public.messages
    set
      status = v_status,
      raw_payload = case
        when jsonb_typeof(raw_payload) = 'object'
          and (raw_payload ? 'storagePath' or raw_payload ? 'upload' or raw_payload ? 'send')
        then raw_payload || jsonb_build_object(
          'send', coalesce(raw_payload->'send', '{}'::jsonb) || v_msg,
          'wamid', coalesce(v_wamid, raw_payload->>'wamid')
        )
        when jsonb_typeof(raw_payload) = 'object' and jsonb_typeof(v_msg) = 'object'
        then raw_payload || v_msg
        else coalesce(v_msg, raw_payload)
      end,
      wamid = coalesce(v_wamid, wamid),
      reply_to_wamid = coalesce(v_reply_to, reply_to_wamid),
      media_url = coalesce(public.messages.media_url, v_media_url),
      media_mime = coalesce(public.messages.media_mime, v_media_mime),
      media_filename = coalesce(public.messages.media_filename, v_media_filename),
      media_sha256 = coalesce(public.messages.media_sha256, v_media_sha256),
      body = case
        when public.messages.body is null or public.messages.body ~ '^\[[a-z_]+\]$'
        then case
          when v_body is not null and not (v_body ~ '^\[[a-z_]+\]$')
          then v_body
          else public.messages.body
        end
        else public.messages.body
      end
    where ycloud_message_id = v_msg_id
       or (v_wamid is not null and wamid = v_wamid);

    if found then
      return jsonb_build_object('ok', true, 'updated', true, 'wamid', v_wamid);
    end if;

    select * into v_inbox from public.inboxes
    where phone_number = v_from
       or regexp_replace(phone_number, '[^0-9]', '', 'g') = regexp_replace(v_from, '[^0-9]', '', 'g')
    limit 1;

    if v_inbox.id is null then
      return jsonb_build_object('ok', true, 'skipped', 'inbox_not_found');
    end if;

    if v_inbox.company_id is null then
      return jsonb_build_object('ok', true, 'skipped', 'inbox_unassigned');
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
      conversation_id, company_id, direction, type, body, ycloud_message_id, wamid, reply_to_wamid, status, raw_payload,
      media_url, media_mime, media_filename, media_sha256
    ) values (
      v_conversation_id, v_inbox.company_id, v_direction, v_msg_type, v_body, v_msg_id, v_wamid, v_reply_to, v_status, v_msg,
      v_media_url, v_media_mime, v_media_filename, v_media_sha256
    )
    on conflict (ycloud_message_id) do update set
      status = excluded.status,
      raw_payload = case
        when jsonb_typeof(public.messages.raw_payload) = 'object'
          and (public.messages.raw_payload ? 'storagePath' or public.messages.raw_payload ? 'upload' or public.messages.raw_payload ? 'send')
        then public.messages.raw_payload || jsonb_build_object(
          'send', coalesce(public.messages.raw_payload->'send', '{}'::jsonb) || excluded.raw_payload,
          'wamid', coalesce(excluded.wamid, public.messages.raw_payload->>'wamid')
        )
        when jsonb_typeof(public.messages.raw_payload) = 'object' and jsonb_typeof(excluded.raw_payload) = 'object'
        then public.messages.raw_payload || excluded.raw_payload
        else coalesce(excluded.raw_payload, public.messages.raw_payload)
      end,
      wamid = coalesce(excluded.wamid, public.messages.wamid),
      reply_to_wamid = coalesce(excluded.reply_to_wamid, public.messages.reply_to_wamid),
      media_url = coalesce(public.messages.media_url, excluded.media_url),
      media_mime = coalesce(public.messages.media_mime, excluded.media_mime),
      media_filename = coalesce(public.messages.media_filename, excluded.media_filename),
      media_sha256 = coalesce(public.messages.media_sha256, excluded.media_sha256),
      body = case
        when public.messages.body is null or public.messages.body ~ '^\[[a-z_]+\]$'
        then case
          when excluded.body is not null and not (excluded.body ~ '^\[[a-z_]+\]$')
          then excluded.body
          else public.messages.body
        end
        else public.messages.body
      end;

    return jsonb_build_object('ok', true, 'conversation_id', v_conversation_id);
  end if;

  return jsonb_build_object('ok', true, 'ignored', p_event_type);
end;
$function$;

-- ============================================================================
-- BACKFILL: 1. Interactive messages
-- ============================================================================
update public.messages
set body = case
  when nullif(trim(raw_payload->'interactive'->'body'->>'text'), '') is not null
   and nullif(trim(raw_payload->'interactive'->'action'->'parameters'->>'url'), '') is not null
  then trim(raw_payload->'interactive'->'body'->>'text') || E'\n' ||
       coalesce(nullif(trim(raw_payload->'interactive'->'action'->'parameters'->>'display_text'), ''), 'Abrir enlace') || ': ' ||
       trim(raw_payload->'interactive'->'action'->'parameters'->>'url')
  when nullif(trim(raw_payload->'interactive'->'body'->>'text'), '') is not null
  then trim(raw_payload->'interactive'->'body'->>'text')
  when nullif(trim(raw_payload->'interactive'->'action'->'parameters'->>'url'), '') is not null
  then coalesce(nullif(trim(raw_payload->'interactive'->'action'->'parameters'->>'display_text'), ''), 'Abrir enlace') || ': ' ||
       trim(raw_payload->'interactive'->'action'->'parameters'->>'url')
  else 'Mensaje interactivo'
end
where type = 'interactive'
  and (body is null or body = '[interactive]');

-- ============================================================================
-- BACKFILL: 2. Media messages (image, audio, video, document, sticker)
-- ============================================================================
update public.messages
set
  media_url = coalesce(
    media_url,
    nullif(raw_payload->type->>'link', '')
  ),
  media_mime = coalesce(
    media_mime,
    nullif(raw_payload->type->>'mime_type', ''),
    nullif(raw_payload->type->>'mimeType', '')
  ),
  media_filename = coalesce(
    media_filename,
    nullif(raw_payload->type->>'filename', '')
  ),
  media_sha256 = coalesce(
    media_sha256,
    nullif(raw_payload->type->>'sha256', '')
  ),
  body = case
    when body is null or body ~ '^\[[a-z_]+\]$'
    then coalesce(
      nullif(raw_payload->type->>'caption', ''),
      nullif(raw_payload->type->>'filename', ''),
      case type
        when 'image' then 'Imagen'
        when 'audio' then 'Nota de voz'
        when 'video' then 'Video'
        when 'document' then 'Documento'
        when 'sticker' then 'Sticker'
        else body
      end
    )
    else body
  end
where type in ('image', 'audio', 'video', 'document', 'sticker')
  and (body is null or body ~ '^\[[a-z_]+\]$' or (media_url is null and raw_payload->type ? 'link'));

-- ============================================================================
-- BACKFILL: 3. Location messages
-- ============================================================================
update public.messages
set body = coalesce(
  case
    when nullif(trim(raw_payload->'location'->>'name'), '') is not null
     and nullif(trim(raw_payload->'location'->>'address'), '') is not null
    then '📍 ' || trim(raw_payload->'location'->>'name') || E'\n' || trim(raw_payload->'location'->>'address')
    when nullif(trim(raw_payload->'location'->>'name'), '') is not null
    then '📍 ' || trim(raw_payload->'location'->>'name')
    when nullif(trim(raw_payload->'location'->>'address'), '') is not null
    then '📍 ' || trim(raw_payload->'location'->>'address')
    when nullif(trim(raw_payload->'location'->>'latitude'), '') is not null
     and nullif(trim(raw_payload->'location'->>'longitude'), '') is not null
    then '📍 Ubicación: ' || trim(raw_payload->'location'->>'latitude') || ', ' || trim(raw_payload->'location'->>'longitude')
    else null
  end,
  '📍 Ubicación compartida'
)
where type = 'location'
  and (body is null or body = '[location]');

-- ============================================================================
-- BACKFILL: 4. Order messages
-- ============================================================================
update public.messages
set body = coalesce(
  nullif(trim(raw_payload->'order'->>'text'), ''),
  case
    when jsonb_typeof(raw_payload->'order'->'product_items') = 'array'
     and jsonb_array_length(raw_payload->'order'->'product_items') > 0
    then '🛒 Pedido de catálogo (' || jsonb_array_length(raw_payload->'order'->'product_items') || ' artículo' ||
         case when jsonb_array_length(raw_payload->'order'->'product_items') > 1 then 's' else '' end || ')'
    else '🛒 Pedido de catálogo'
  end
)
where type = 'order'
  and (body is null or body = '[order]');

-- ============================================================================
-- BACKFILL: 5. Contacts messages
-- ============================================================================
do $$
declare
  r record;
  v_b text;
  v_elem jsonb;
  v_line text;
  v_phone jsonb;
begin
  for r in
    select id, raw_payload
    from public.messages
    where type = 'contacts' and (body is null or body = '[contacts]')
  loop
    v_b := '';
    for v_elem in
      select value from jsonb_array_elements(coalesce(r.raw_payload->'contacts', '[]'::jsonb))
    loop
      v_line := coalesce(
        nullif(trim(v_elem->'name'->>'formatted_name'), ''),
        nullif(trim(concat_ws(' ',
          nullif(v_elem->'name'->>'first_name', ''),
          nullif(v_elem->'name'->>'middle_name', ''),
          nullif(v_elem->'name'->>'last_name', '')
        )), ''),
        'Contacto'
      );
      v_b := case when v_b = '' then v_line else v_b || E'\n' || v_line end;
      for v_phone in
        select value from jsonb_array_elements(coalesce(v_elem->'phones', '[]'::jsonb))
      loop
        v_line := coalesce(nullif(v_phone->>'phone', ''), nullif(v_phone->>'wa_id', ''));
        if v_line is not null then
          if nullif(v_phone->>'type', '') is not null then
            v_line := v_phone->>'type' || ': ' || v_line;
          end if;
          v_b := v_b || E'\n' || v_line;
        end if;
      end loop;
    end loop;
    if coalesce(v_b, '') = '' then
      v_b := 'Contacto compartido';
    end if;
    update public.messages set body = v_b where id = r.id;
  end loop;
end;
$$;

-- ============================================================================
-- BACKFILL: 6. Any other stray [placeholder] bodies
-- ============================================================================
update public.messages
set body = case body
  when '[image]' then 'Imagen'
  when '[audio]' then 'Nota de voz'
  when '[video]' then 'Video'
  when '[document]' then 'Documento'
  when '[sticker]' then 'Sticker'
  when '[interactive]' then 'Mensaje interactivo'
  when '[location]' then 'Ubicación'
  when '[contacts]' then 'Contacto compartido'
  when '[order]' then 'Pedido'
  else regexp_replace(body, '^\[(.*)\]$', '\1')
end
where body ~ '^\[[a-z_]+\]$';

-- ============================================================================
-- BACKFILL: 7. Synchronize conversations.last_message_preview
-- ============================================================================
update public.conversations c
set last_message_preview = left(m.body, 200)
from (
  select distinct on (conversation_id) conversation_id, body
  from public.messages
  where body is not null
  order by conversation_id, created_at desc
) m
where c.id = m.conversation_id
  and (c.last_message_preview ~ '^\[[a-z_]+\]' or c.last_message_preview is null);
