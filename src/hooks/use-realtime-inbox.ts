"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { emitSofiaNotify } from "@/lib/sofia-notify";

type MessageRow = {
  id: string;
  conversation_id: string;
  direction: string;
  type: string;
  body: string | null;
  status: string;
  created_at: string;
  template_name: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  media_filename?: string | null;
};

type ConversationPatch = {
  id: string;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  unread_count?: number;
  window_expires_at?: string | null;
  assignee_id?: string | null;
  status?: string;
};

export function useRealtimeInbox({
  activeConversationId,
  onMessage,
  onConversationChange,
  onReloadConversations,
}: {
  activeConversationId?: string;
  onMessage: (message: MessageRow) => void;
  onConversationChange: (patch: ConversationPatch) => void;
  onReloadConversations: () => void;
}) {
  const activeIdRef = useRef(activeConversationId);
  const onMessageRef = useRef(onMessage);
  const onConversationChangeRef = useRef(onConversationChange);
  const onReloadRef = useRef(onReloadConversations);

  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onConversationChangeRef.current = onConversationChange;
    onReloadRef.current = onReloadConversations;
  }, [onMessage, onConversationChange, onReloadConversations]);

  // Stable list channel — does not recreate when switching threads
  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session?.access_token) {
        supabase.realtime.setAuth(data.session.access_token);
      }
    });
    const listChannel = supabase
      .channel("sofia-conversations-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          const row = (payload.new || payload.old) as ConversationPatch | null;
          if (!row?.id) {
            onReloadRef.current();
            return;
          }
          if (payload.eventType === "INSERT") {
            onReloadRef.current();
            return;
          }
          if (payload.eventType === "UPDATE" && payload.new) {
            onConversationChangeRef.current(payload.new as ConversationPatch);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const msg = payload.new as MessageRow;
          if (!msg?.conversation_id) return;
          // Active thread inserts are handled by the dedicated thread channel.
          if (msg.conversation_id === activeIdRef.current) {
            onConversationChangeRef.current({
              id: msg.conversation_id,
              last_message_at: msg.created_at,
              last_message_preview: msg.body,
              unread_count: 0,
            });
          } else {
            onConversationChangeRef.current({
              id: msg.conversation_id,
              last_message_at: msg.created_at,
              last_message_preview: msg.body,
              unread_count: undefined,
            });
          }
          if (msg.direction === "inbound") {
            emitSofiaNotify({
              type: "message",
              conversationId: msg.conversation_id,
              messageId: msg.id,
              body: msg.body,
              createdAt: msg.created_at,
            });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(listChannel);
    };
  }, []);

  // Thread channel only for the active conversation (status updates, etc.)
  useEffect(() => {
    if (!activeConversationId) return;
    const supabase = createClient();
    const threadChannel = supabase
      .channel(`sofia-thread-${activeConversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${activeConversationId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT" && payload.new) {
            onMessageRef.current(payload.new as MessageRow);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(threadChannel);
    };
  }, [activeConversationId]);
}
