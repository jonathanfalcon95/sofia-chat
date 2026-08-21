"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { ConversationRow, MessageRow, NoteRow } from "@/lib/conversations/types";

export type ThreadBootstrapPayload = {
  conversationId: string;
  messages: MessageRow[];
  hasMore: boolean;
  notes?: NoteRow[];
  conversation?: ConversationRow | null;
  missing?: boolean;
};

type InboxThreadContextValue = {
  applyBootstrap: (payload: ThreadBootstrapPayload) => void;
};

const InboxThreadContext = createContext<InboxThreadContextValue | null>(null);

export function InboxThreadProvider({
  applyBootstrap,
  children,
}: {
  applyBootstrap: (payload: ThreadBootstrapPayload) => void;
  children: React.ReactNode;
}) {
  const applyRef = useRef(applyBootstrap);

  useEffect(() => {
    applyRef.current = applyBootstrap;
  }, [applyBootstrap]);

  const value = useMemo<InboxThreadContextValue>(
    () => ({
      applyBootstrap: (payload) => applyRef.current(payload),
    }),
    [],
  );

  return (
    <InboxThreadContext.Provider value={value}>
      {children}
    </InboxThreadContext.Provider>
  );
}

export function useInboxThreadContext() {
  const ctx = useContext(InboxThreadContext);
  if (!ctx) {
    throw new Error("useInboxThreadContext must be used within InboxThreadProvider");
  }
  return ctx;
}

export function InboxThreadBootstrap({
  conversationId,
  initialMessages,
  initialHasMoreMessages = false,
  initialNotes = [],
  conversation = null,
  missing = false,
}: {
  conversationId: string;
  initialMessages: MessageRow[];
  initialHasMoreMessages?: boolean;
  initialNotes?: NoteRow[];
  conversation?: ConversationRow | null;
  missing?: boolean;
}) {
  const { applyBootstrap } = useInboxThreadContext();

  useEffect(() => {
    applyBootstrap({
      conversationId,
      messages: initialMessages,
      hasMore: initialHasMoreMessages,
      notes: initialNotes,
      conversation,
      missing,
    });
  }, [
    applyBootstrap,
    conversation,
    conversationId,
    initialMessages,
    initialHasMoreMessages,
    initialNotes,
    missing,
  ]);

  return null;
}
