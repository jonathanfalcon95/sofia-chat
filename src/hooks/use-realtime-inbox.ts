"use client";

import { useEffect } from "react";
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
            onReloadConversations();
            return;
          }
          if (payload.eventType === "INSERT") {
            onReloadConversations();
            return;
          }
          if (payload.eventType === "UPDATE" && payload.new) {
            onConversationChange(payload.new as ConversationPatch);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          const msg = payload.new as MessageRow;
          if (!msg?.conversation_id) return;
          if (msg.conversation_id === activeConversationId) {
            onMessage(msg);
          }
          onConversationChange({
            id: msg.conversation_id,
            last_message_at: msg.created_at,
            last_message_preview: msg.body,
            unread_count:
              msg.conversation_id === activeConversationId
                ? 0
                : undefined,
          });
          // Backup path for the notification bell (works even if bell channel lags)
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
  }, [
    activeConversationId,
    onConversationChange,
    onMessage,
    onReloadConversations,
  ]);

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
            onMessage(payload.new as MessageRow);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(threadChannel);
    };
  }, [activeConversationId, onMessage]);
}
