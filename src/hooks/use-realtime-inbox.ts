"use client";

import { useEffect, useRef } from "react";
import { realtimeMode, subscribeRealtime } from "@/lib/realtime/client";
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
  company_id?: string;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  unread_count?: number;
  /** Optimistic +1 for inbound on a non-active thread (until conversations UPDATE). */
  bump_unread?: boolean;
  window_expires_at?: string | null;
  assignee_id?: string | null;
  status?: string;
};

export function useRealtimeInbox({
  activeConversationId,
  companyId,
  onMessage,
  onConversationChange,
  onReloadConversations,
}: {
  activeConversationId?: string;
  companyId?: string;
  onMessage: (message: MessageRow) => void;
  onConversationChange: (patch: ConversationPatch) => void;
  onReloadConversations: () => void;
}) {
  const activeIdRef = useRef(activeConversationId);
  const companyIdRef = useRef(companyId);
  const onMessageRef = useRef(onMessage);
  const onConversationChangeRef = useRef(onConversationChange);
  const onReloadRef = useRef(onReloadConversations);

  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    companyIdRef.current = companyId;
  }, [companyId]);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onConversationChangeRef.current = onConversationChange;
    onReloadRef.current = onReloadConversations;
  }, [onMessage, onConversationChange, onReloadConversations]);

  // List channel — recreate when the company filter changes.
  useEffect(() => {
    const handleConversation = (
      eventType: string,
      row: ConversationPatch | null,
    ) => {
      if (!row?.id) {
        onReloadRef.current();
        return;
      }
      const selectedCompanyId = companyIdRef.current;
      if (
        selectedCompanyId &&
        row.company_id &&
        row.company_id !== selectedCompanyId
      ) {
        return;
      }
      if (eventType === "INSERT") {
        onReloadRef.current();
        return;
      }
      if (eventType === "UPDATE") {
        onConversationChangeRef.current(row);
      }
    };

    const handleNewMessage = (msg: MessageRow) => {
      if (!msg?.conversation_id) return;
      // Reactions are metadata on another message — never preview/notify.
      if (msg.type === "reaction") return;
      const isActive = msg.conversation_id === activeIdRef.current;
      // Preview updates only. Unread for non-active inbound comes from the
      // conversations UPDATE (webhook). Active threads stay read (0).
      // Do NOT bump unread on outbound — that falsely marked chats unread.
      onConversationChangeRef.current({
        id: msg.conversation_id,
        last_message_at: msg.created_at,
        last_message_preview: msg.body,
        ...(isActive
          ? { unread_count: 0 }
          : msg.direction === "inbound"
            ? { bump_unread: true }
            : {}),
      });
      if (msg.direction === "inbound") {
        emitSofiaNotify({
          type: "message",
          conversationId: msg.conversation_id,
          messageId: msg.id,
          body: msg.body,
          createdAt: msg.created_at,
        });
      }
    };

    const connectSupabase = () => {
      const supabase = createClient();
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session?.access_token) {
          supabase.realtime.setAuth(data.session.access_token);
        }
      });
      const listChannel = supabase
        .channel(`sofia-conversations-list-${companyId || "all"}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "conversations",
            ...(companyId ? { filter: `company_id=eq.${companyId}` } : {}),
          },
          (payload) =>
            handleConversation(
              payload.eventType,
              (payload.new || payload.old) as ConversationPatch | null,
            ),
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            ...(companyId ? { filter: `company_id=eq.${companyId}` } : {}),
          },
          (payload) => handleNewMessage(payload.new as MessageRow),
        )
        .subscribe();
      return () => {
        supabase.removeChannel(listChannel);
      };
    };

    const connectPolling = () =>
      subscribeRealtime((signal) => {
        if ("resync" in signal) {
          onReloadRef.current();
          return;
        }
        if (signal.table === "conversations") {
          handleConversation(signal.eventType, signal.row as ConversationPatch);
        } else if (signal.eventType === "INSERT") {
          if (companyIdRef.current && signal.companyId !== companyIdRef.current) return;
          handleNewMessage(signal.row as unknown as MessageRow);
        }
      });

    let cancelled = false;
    let disconnect = () => {};
    void realtimeMode().then((mode) => {
      if (cancelled) return;
      disconnect = mode === "sqlserver" ? connectPolling() : connectSupabase();
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [companyId]);

  // Thread channel only for the active conversation (status updates, etc.)
  useEffect(() => {
    if (!activeConversationId) return;

    const connectSupabase = () => {
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
            if (
              (payload.eventType === "INSERT" || payload.eventType === "UPDATE") &&
              payload.new
            ) {
              onMessageRef.current(payload.new as MessageRow);
            }
          },
        )
        .subscribe();
      return () => {
        supabase.removeChannel(threadChannel);
      };
    };

    const connectPolling = () =>
      subscribeRealtime((signal) => {
        if ("resync" in signal || signal.table !== "messages") return;
        if (signal.row.conversation_id === activeConversationId) {
          onMessageRef.current(signal.row as unknown as MessageRow);
        }
      });

    let cancelled = false;
    let disconnect = () => {};
    void realtimeMode().then((mode) => {
      if (cancelled) return;
      disconnect = mode === "sqlserver" ? connectPolling() : connectSupabase();
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [activeConversationId]);
}
