"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";
import {
  ArrowLeft,
  Filter,
  Info,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isWithinCustomerWindow } from "@/lib/utils";
import {
  rememberMediaPreview,
  takeMediaPreview,
} from "@/lib/media-preview-cache";
import {
  PRIORITY_LABELS,
  TICKET_PRIORITIES,
  type TicketPriority,
} from "@/lib/tickets";
import { useRealtimeInbox } from "@/hooks/use-realtime-inbox";
import { createTicket } from "@/app/actions/conversations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageThread } from "@/components/conversations/message-thread";
import {
  CONVERSATION_LIST_SELECT,
  MESSAGE_PAGE_SIZE,
  type AssigneeFilter,
  type ConversationRow,
  type MessageRow,
  type NoteRow,
} from "@/lib/conversations/types";
import {
  normalizeConversations,
  normalizeNotes,
} from "@/lib/conversations/normalize";
import {
  durationSince,
  nowMs as perfNowMs,
  reportClientConversationMetric,
} from "@/lib/conversations/perf";

const ConversationSidePanel = dynamic(
  () =>
    import("@/components/conversations/conversation-side-panel").then(
      (m) => m.ConversationSidePanel,
    ),
  {
    ssr: false,
    loading: () => (
      <p className="text-sm text-[var(--muted)]">Cargando panel…</p>
    ),
  },
);

export function InboxView({
  initialConversations,
  agents,
  tags,
  contactTags = [],
  selectedId,
  currentUserId,
  initialMessages = [],
  initialNotes = [],
  initialHasMoreMessages = false,
}: {
  initialConversations: ConversationRow[];
  agents: Array<{
    id: string;
    full_name: string | null;
    email: string;
    company_id: string;
  }>;
  tags: Array<{ id: string; name: string; color: string; company_id: string }>;
  contactTags?: Array<{
    id: string;
    name: string;
    color: string;
    company_id: string;
  }>;
  selectedId?: string;
  currentUserId?: string;
  initialMessages?: MessageRow[];
  initialNotes?: NoteRow[];
  initialHasMoreMessages?: boolean;
}) {
  const router = useRouter();
  const [conversations, setConversations] = useState(initialConversations);
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  const [pendingRouteId, setPendingRouteId] = useState<string | null>(null);
  const activeId = selectedId ?? null;

  const [messages, setMessages] = useState<MessageRow[]>(initialMessages);
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);
  const [hasMoreMessages, setHasMoreMessages] = useState(initialHasMoreMessages);
  const [loadingThread, setLoadingThread] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [ticketOpen, setTicketOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [ticketTitle, setTicketTitle] = useState("");
  const [ticketDescription, setTicketDescription] = useState("");
  const [ticketPriority, setTicketPriority] =
    useState<TicketPriority>("medium");
  const [filterContactTagId, setFilterContactTagId] = useState("");
  const [phoneSearch, setPhoneSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>("all");
  const [savingTagId, setSavingTagId] = useState<string | null>(null);
  const [mediaSending, setMediaSending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const appliedSelectedIdRef = useRef<string | null>(null);
  const desktopRedirectRef = useRef(false);
  const prefetchedConversationIdsRef = useRef<Set<string>>(new Set());
  const notesLoadingForIdRef = useRef<string | null>(null);
  const reloadDebounceRef = useRef<number | null>(null);
  const openStartByConversationRef = useRef<Map<string, number>>(new Map());
  const threadCacheRef = useRef<
    Map<string, { messages: MessageRow[]; notes: NoteRow[]; hasMore: boolean }>
  >(new Map());

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );
  const highlightedId =
    pendingRouteId && pendingRouteId !== selectedId
      ? pendingRouteId
      : activeId;

  useEffect(() => {
    const id = window.setTimeout(() => {
      setConversations(initialConversations);
    }, 0);
    return () => window.clearTimeout(id);
  }, [initialConversations]);

  useEffect(() => {
    if (!selectedId) return;
    const id = window.setTimeout(() => {
      setPendingRouteId((prev) => (prev === selectedId ? null : prev));
    }, 0);
    return () => window.clearTimeout(id);
  }, [selectedId]);

  const filteredConversations = useMemo(() => {
    const query = phoneSearch.trim().toLowerCase();
    const digits = phoneSearch.replace(/\D/g, "");

    return conversations.filter((c) => {
      if (
        filterContactTagId &&
        !c.contacts?.contact_tags?.some((t) => t.tag_id === filterContactTagId)
      ) {
        return false;
      }
      if (assigneeFilter === "mine") {
        if (!(currentUserId && c.assignee_id === currentUserId)) return false;
      } else if (assigneeFilter === "unassigned") {
        if (c.assignee_id) return false;
      }

      if (query || digits) {
        const name = (c.contacts?.name || "").toLowerCase();
        const phone = c.contacts?.phone_number || "";
        const phoneDigits = phone.replace(/\D/g, "");
        const nameMatch = query ? name.includes(query) : false;
        const phoneMatch = digits
          ? phoneDigits.includes(digits) || phone.toLowerCase().includes(query)
          : phone.toLowerCase().includes(query);
        if (!nameMatch && !phoneMatch) return false;
      }

      return true;
    });
  }, [
    conversations,
    filterContactTagId,
    assigneeFilter,
    currentUserId,
    phoneSearch,
  ]);

  function resizeComposer() {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 136)}px`;
  }

  function insertEmoji(emoji: string) {
    const el = composerRef.current;
    if (!el) {
      setText((prev) => prev + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
      resizeComposer();
    });
  }

  useLayoutEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Desktop first login: land on a deep-linked chat (SSR messages) instead of
  // client-fetching the first thread (that caused skeleton flicker).
  useEffect(() => {
    if (selectedId || isDesktop !== true || desktopRedirectRef.current) return;
    const firstId = initialConversations[0]?.id;
    if (!firstId) return;
    desktopRedirectRef.current = true;
    router.replace(`/conversations/${firstId}`);
  }, [selectedId, isDesktop, initialConversations, router]);

  const reloadConversations = useCallback(async () => {
    const supabase = createClient();
    const startedAt = perfNowMs();
    const { data } = await supabase
      .from("conversations")
      .select(CONVERSATION_LIST_SELECT)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(100);
    setConversations(
      normalizeConversations(data as Array<Record<string, unknown>> | null),
    );
    reportClientConversationMetric("conversation_list_reload", {
      durationMs: durationSince(startedAt),
      rows: data?.length ?? 0,
    });
  }, []);

  const queueReloadConversations = useCallback(() => {
    if (reloadDebounceRef.current) return;
    reloadDebounceRef.current = window.setTimeout(() => {
      reloadDebounceRef.current = null;
      void reloadConversations();
    }, 300);
  }, [reloadConversations]);

  const onMessage = useCallback((msg: MessageRow) => {
    setMessages((prev) => {
      const cached = takeMediaPreview(msg.id);
      const enriched: MessageRow = cached
        ? { ...msg, localPreviewUrl: cached }
        : msg;
      if (prev.some((m) => m.id === enriched.id)) {
        return prev.map((m) =>
          m.id === enriched.id
            ? {
                ...m,
                ...enriched,
                localPreviewUrl: m.localPreviewUrl || enriched.localPreviewUrl,
              }
            : m,
        );
      }
      const withoutDupPending = prev.filter(
        (m) =>
          !(
            m.id.startsWith("temp-") &&
            m.direction === "outbound" &&
            enriched.direction === "outbound" &&
            m.body === enriched.body &&
            m.type === enriched.type
          ),
      );
      return [...withoutDupPending, enriched];
    });
  }, []);

  const onConversationChange = useCallback(
    (patch: {
      id: string;
      last_message_at?: string | null;
      last_message_preview?: string | null;
      unread_count?: number;
      window_expires_at?: string | null;
      assignee_id?: string | null;
      status?: string;
    }) => {
      setConversations((prev) => {
        const exists = prev.some((c) => c.id === patch.id);
        if (!exists) {
          queueReloadConversations();
          return prev;
        }
        return prev
          .map((c) =>
            c.id === patch.id
              ? {
                  ...c,
                  ...patch,
                  unread_count:
                    patch.unread_count === undefined
                      ? c.id === activeId
                        ? 0
                        : Math.max(c.unread_count, 1)
                      : patch.unread_count,
                }
              : c,
          )
          .sort((a, b) => {
            const ta = a.last_message_at
              ? new Date(a.last_message_at).getTime()
              : 0;
            const tb = b.last_message_at
              ? new Date(b.last_message_at).getTime()
              : 0;
            return tb - ta;
          });
      });
    },
    [activeId, queueReloadConversations],
  );

  useRealtimeInbox({
    activeConversationId: activeId ?? undefined,
    onMessage,
    onConversationChange,
    onReloadConversations: queueReloadConversations,
  });

  const markConversationRead = useCallback((conversationId: string) => {
    void createClient()
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId);
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId ? { ...c, unread_count: 0 } : c,
      ),
    );
  }, []);

  const loadNotesInBackground = useCallback(async (conversationId: string) => {
    if (!conversationId) return;
    if (notesLoadingForIdRef.current === conversationId) return;
    notesLoadingForIdRef.current = conversationId;
    try {
      const supabase = createClient();
      const { data: noteRows } = await supabase
        .from("conversation_notes")
        .select("id, body, created_at, profiles(full_name, email)")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false });
      const normalized = normalizeNotes(
        noteRows as Array<Record<string, unknown>> | null,
      );
      const cached = threadCacheRef.current.get(conversationId);
      threadCacheRef.current.set(conversationId, {
        messages: cached?.messages ?? [],
        notes: normalized,
        hasMore: cached?.hasMore ?? false,
      });
      if (selectedId === conversationId) {
        setNotes(normalized);
        reportClientConversationMetric("thread_ready", {
          conversationId,
        });
      }
    } finally {
      notesLoadingForIdRef.current = null;
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      appliedSelectedIdRef.current = null;
      return;
    }
    if (appliedSelectedIdRef.current === selectedId) {
      return;
    }
    const startedAt = openStartByConversationRef.current.get(selectedId);
    const cached = threadCacheRef.current.get(selectedId);
    const nextMessages = initialMessages.map((m) => {
      const cachedPreview = takeMediaPreview(m.id);
      return cachedPreview ? { ...m, localPreviewUrl: cachedPreview } : m;
    });
    const syncStateTimer = window.setTimeout(() => {
      setLoadingThread(false);
      setMessages(nextMessages);
      setHasMoreMessages(initialHasMoreMessages);
      if (initialNotes.length > 0) {
        setNotes(initialNotes);
        reportClientConversationMetric("thread_ready", {
          conversationId: selectedId,
        });
      } else {
        setNotes(cached?.notes ?? []);
        void loadNotesInBackground(selectedId);
      }
    }, 0);
    threadCacheRef.current.set(selectedId, {
      messages: nextMessages,
      notes: initialNotes.length > 0 ? initialNotes : cached?.notes ?? [],
      hasMore: initialHasMoreMessages,
    });
    markConversationRead(selectedId);
    appliedSelectedIdRef.current = selectedId;
    reportClientConversationMetric("thread_ready_payload", {
      conversationId: selectedId,
      durationMs: startedAt ? durationSince(startedAt) : null,
      messageCount: nextMessages.length,
      hasCachedNotes: Boolean(cached?.notes?.length),
    });
    return () => window.clearTimeout(syncStateTimer);
  }, [
    initialHasMoreMessages,
    initialMessages,
    initialNotes,
    loadNotesInBackground,
    markConversationRead,
    selectedId,
  ]);

  useEffect(() => {
    if (!activeId) return;
    threadCacheRef.current.set(activeId, {
      messages,
      notes,
      hasMore: hasMoreMessages,
    });
  }, [activeId, hasMoreMessages, messages, notes]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (reloadDebounceRef.current) {
        window.clearTimeout(reloadDebounceRef.current);
      }
    };
  }, []);

  // nowMs refreshes window status every 30s
  void nowMs;
  const canText = isWithinCustomerWindow(active?.window_expires_at);

  const windowHint = (() => {
    if (!active?.window_expires_at) {
      return "Sin ventana activa: espera un mensaje del contacto";
    }
    const expires = new Date(active.window_expires_at);
    if (expires.getTime() <= nowMs) {
      return "Ventana de 24h cerrada: el contacto debe escribir primero";
    }
    return `Ventana abierta · cierra ${formatDistanceToNow(expires, {
      addSuffix: true,
      locale: es,
    })}`;
  })();

  function focusComposer() {
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }

  const prefetchConversationRoute = useCallback(
    (id: string) => {
      if (prefetchedConversationIdsRef.current.has(id)) return;
      prefetchedConversationIdsRef.current.add(id);
      router.prefetch(`/conversations/${id}`);
    },
    [router],
  );

  function openConversation(id: string) {
    if (id === selectedId) {
      setPendingRouteId(null);
      return;
    }
    setPendingRouteId(id);
    openStartByConversationRef.current.set(id, perfNowMs());
    reportClientConversationMetric("conversation_open_start", {
      conversationId: id,
    });
    prefetchConversationRoute(id);
    router.push(`/conversations/${id}`, { scroll: false });
  }

  function backToList() {
    setPendingRouteId(null);
    setMessages([]);
    setNotes([]);
    setHasMoreMessages(false);
    setDetailOpen(false);
    if (
      selectedId ||
      window.matchMedia("(max-width: 900px)").matches
    ) {
      router.push("/conversations", { scroll: false });
    }
  }

  async function loadOlderMessages() {
    if (!activeId || loadingOlder || !hasMoreMessages || messages.length === 0) {
      return;
    }
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("messages")
      .select(
        "id, direction, type, body, status, created_at, template_name, conversation_id, media_url, media_mime, media_filename",
      )
      .eq("conversation_id", activeId)
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);
    const older = ((data as MessageRow[]) ?? []).slice().reverse();
    setHasMoreMessages((data?.length ?? 0) >= MESSAGE_PAGE_SIZE);
    setMessages((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      return [...older.filter((m) => !ids.has(m.id)), ...prev];
    });
    setLoadingOlder(false);
  }

  function sendTextOptimistic() {
    if (!active) return;
    const payload = text.trim();
    if (!payload || !isWithinCustomerWindow(active.window_expires_at)) return;

    const conversationId = active.id;
    const tempId = `temp-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();

    setText("");
    focusComposer();
    requestAnimationFrame(() => resizeComposer());

    const optimistic: MessageRow = {
      id: tempId,
      conversation_id: conversationId,
      direction: "outbound",
      type: "text",
      body: payload,
      status: "pending",
      created_at: createdAt,
      template_name: null,
    };

    setMessages((prev) => [...prev, optimistic]);
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              last_message_at: createdAt,
              last_message_preview: payload.slice(0, 200),
            }
          : c,
      ),
    );

    void (async () => {
      try {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            mode: "text",
            text: payload,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al enviar");

        setMessages((prev) => {
          const withoutTemp = prev.filter((m) => m.id !== tempId);
          if (data.message) {
            if (withoutTemp.some((m) => m.id === data.message.id)) {
              return withoutTemp;
            }
            return [...withoutTemp, data.message as MessageRow];
          }
          return withoutTemp.map((m) =>
            m.id === tempId ? { ...m, status: "accepted" } : m,
          );
        });
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId ? { ...m, status: "failed" } : m,
          ),
        );
        toast.error(e instanceof Error ? e.message : "No se pudo enviar");
      }
    })();
  }

  async function sendMediaFile(file: File, caption?: string) {
    if (!active || !isWithinCustomerWindow(active.window_expires_at)) {
      throw new Error("Fuera de la ventana de 24h");
    }
    const conversationId = active.id;
    const tempId = `temp-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const localPreviewUrl = URL.createObjectURL(file);
    const mime = file.type.split(";")[0] || "application/octet-stream";
    const type = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : "document";
    const body =
      caption ||
      (type === "audio" ? "Nota de voz" : type === "image" ? "Imagen" : file.name);

    const optimistic: MessageRow = {
      id: tempId,
      conversation_id: conversationId,
      direction: "outbound",
      type,
      body,
      status: "pending",
      created_at: createdAt,
      template_name: null,
      media_mime: mime,
      media_filename: file.name,
      localPreviewUrl,
    };
    setMessages((prev) => [...prev, optimistic]);
    setMediaSending(true);

    try {
      const form = new FormData();
      form.set("conversationId", conversationId);
      form.set("file", file);
      if (caption) form.set("caption", caption);

      const res = await fetch("/api/messages/send-media", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al enviar media");

      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        if (data.message) {
          const msgId = String((data.message as MessageRow).id);
          rememberMediaPreview(msgId, localPreviewUrl);
          const msg: MessageRow = {
            ...(data.message as MessageRow),
            localPreviewUrl,
          };
          if (withoutTemp.some((m) => m.id === msg.id)) {
            return withoutTemp.map((m) =>
              m.id === msg.id
                ? {
                    ...m,
                    ...msg,
                    localPreviewUrl: localPreviewUrl || m.localPreviewUrl,
                  }
                : m,
            );
          }
          return [...withoutTemp, msg];
        }
        return withoutTemp.map((m) =>
          m.id === tempId ? { ...m, status: "accepted" } : m,
        );
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                last_message_at: createdAt,
                last_message_preview: body.slice(0, 200),
              }
            : c,
        ),
      );
    } catch (e) {
      URL.revokeObjectURL(localPreviewUrl);
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, status: "failed" } : m)),
      );
      throw e;
    } finally {
      setMediaSending(false);
    }
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canText && text.trim()) {
        sendTextOptimistic();
      }
    }
  }

  const mobileView = activeId ? "thread" : "list";

  return (
    <div>
      <div className={`chat-layout chat-mobile-${mobileView}`}>
        <section className="chat-pane chat-pane-list">
          <div className="space-y-2 border-b border-[var(--line)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-base font-bold">Conversaciones</h2>
                <Badge>{filteredConversations.length}</Badge>
              </div>
              {contactTags.length > 0 ? (
                <label className="flex max-w-[45%] items-center gap-1.5 text-[var(--muted)]">
                  <Filter className="h-3.5 w-3.5 shrink-0" />
                  <select
                    value={filterContactTagId}
                    onChange={(e) => setFilterContactTagId(e.target.value)}
                    className="h-11 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1 text-xs text-[var(--muted)] outline-none hover:border-[var(--line)] hover:bg-[var(--surface-2)] focus:border-[var(--line)] focus:bg-[var(--surface-2)]"
                    aria-label="Filtrar por tag"
                  >
                    <option value="">Tags</option>
                    {contactTags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  { id: "all", label: "Todas" },
                  { id: "mine", label: "Mías" },
                  { id: "unassigned", label: "Sin asignar" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAssigneeFilter(opt.id)}
                  className={`min-h-9 rounded-full px-3 py-1.5 text-[11px] font-medium transition ${
                    assigneeFilter === opt.id
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
              <Input
                value={phoneSearch}
                onChange={(e) => setPhoneSearch(e.target.value)}
                placeholder="Buscar por teléfono o nombre..."
                className="min-h-11 pl-8 pr-8"
                aria-label="Buscar conversaciones"
              />
              {phoneSearch ? (
                <button
                  type="button"
                  onClick={() => setPhoneSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--muted)] hover:text-[var(--ink)]"
                  aria-label="Limpiar búsqueda"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {filterContactTagId ? (
              <div className="flex flex-wrap gap-1">
                {contactTags
                  .filter((t) => t.id === filterContactTagId)
                  .map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setFilterContactTagId("")}
                      className="inline-flex min-h-9 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        background: `${t.color}22`,
                        color: t.color,
                        border: `1px solid ${t.color}55`,
                      }}
                      title="Quitar filtro"
                    >
                      {t.name} ×
                    </button>
                  ))}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {filteredConversations.length === 0 ? (
              <div className="p-6 text-sm text-[var(--muted)]">
                {phoneSearch.trim()
                  ? "Ninguna conversación coincide con la búsqueda"
                  : "Sin conversaciones aún"}
              </div>
            ) : (
              filteredConversations.map((c) => {
                const contact = c.contacts;
                const tag = c.conversation_tags?.[0]?.tags;
                const activeRow = c.id === highlightedId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openConversation(c.id)}
                    onMouseEnter={() => prefetchConversationRoute(c.id)}
                    onFocus={() => prefetchConversationRoute(c.id)}
                    className={`chat-row w-full border-b border-[var(--line)] px-4 py-3 text-left transition ${
                      activeRow
                        ? "bg-[var(--accent-soft)]"
                        : "hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <strong className="text-sm">
                        {contact?.name || contact?.phone_number}
                      </strong>
                      <span className="text-[11px] text-[var(--muted)]">
                        {c.last_message_at
                          ? formatDistanceToNow(new Date(c.last_message_at), {
                              addSuffix: true,
                              locale: es,
                            })
                          : ""}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-[var(--muted)]">
                      {c.last_message_preview || "Sin mensajes"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge className="normal-case">{c.inboxes?.name}</Badge>
                      {tag ? (
                        <Badge
                          style={{
                            background: `${tag.color}22`,
                            color: tag.color,
                            borderColor: `${tag.color}55`,
                          }}
                        >
                          {tag.name}
                        </Badge>
                      ) : null}
                      {(contact?.contact_tags ?? []).map((ct) =>
                        ct.tags ? (
                          <Badge
                            key={ct.tag_id}
                            style={{
                              background: `${ct.tags.color}22`,
                              color: ct.tags.color,
                              borderColor: `${ct.tags.color}55`,
                            }}
                          >
                            {ct.tags.name}
                          </Badge>
                        ) : null,
                      )}
                      {c.unread_count > 0 ? (
                        <Badge className="bg-[var(--accent)] text-white">
                          {c.unread_count}
                        </Badge>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="chat-pane chat-pane-thread min-h-0">
          {active ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5 sm:px-4 sm:py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={backToList}
                    className="app-nav-toggle h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--ink)] hover:bg-[var(--surface-2)]"
                    aria-label="Volver a conversaciones"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-bold">
                      {active.contacts?.name || active.contacts?.phone_number}
                    </h2>
                    <p className="truncate text-xs text-[var(--muted)]">
                      {active.contacts?.phone_number} · {active.inboxes?.name}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge
                    className={
                      canText
                        ? "hidden border-emerald-500/30 text-emerald-400 sm:inline-flex"
                        : "hidden border-amber-500/30 text-amber-400 sm:inline-flex"
                    }
                    title={windowHint}
                  >
                    {canText ? "Ventana 24h abierta" : "Ventana 24h cerrada"}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setDetailOpen(true)}
                    className="chat-detail-trigger h-11 w-11 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] hover:bg-[var(--accent-soft)]"
                    aria-label="Detalle de conversación"
                  >
                    <Info className="h-4 w-4" />
                  </button>
                </div>
              </header>

              <MessageThread
                activeConversationId={active.id}
                messages={messages}
                loadingThread={loadingThread}
                loadingOlder={loadingOlder}
                hasMore={hasMoreMessages}
                onLoadOlder={() => void loadOlderMessages()}
                canText={canText}
                windowHint={windowHint}
                text={text}
                onTextChange={setText}
                onSend={() => sendTextOptimistic()}
                onSendMedia={sendMediaFile}
                mediaSending={mediaSending}
                onComposerKeyDown={handleComposerKeyDown}
                composerRef={composerRef}
                onInsertEmoji={insertEmoji}
                onResizeComposer={resizeComposer}
                onFirstPaint={(conversationId) => {
                  const startedAt =
                    openStartByConversationRef.current.get(conversationId);
                  reportClientConversationMetric("thread_first_paint", {
                    conversationId,
                    durationMs: startedAt ? durationSince(startedAt) : null,
                  });
                }}
              />
            </div>
          ) : activeId ? (
            <div className="m-auto flex items-center gap-2 p-6 text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando conversación…
            </div>
          ) : (
            <div className="m-auto hidden items-center gap-2 p-6 text-[var(--muted)] sm:flex">
              <Loader2 className="h-4 w-4" /> Selecciona una conversación
            </div>
          )}
        </section>

        <section className="chat-pane chat-pane-side overflow-auto p-4">
          <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-[var(--muted)]">
            Panel
          </h3>
          {active ? (
            <ConversationSidePanel
              active={active}
              agents={agents}
              tags={tags}
              contactTags={contactTags}
              notes={notes}
              note={note}
              onNoteChange={setNote}
              onNotesChange={setNotes}
              onConversationsChange={setConversations}
              savingTagId={savingTagId}
              onSavingTagIdChange={setSavingTagId}
              onOpenTicket={() => setTicketOpen(true)}
            />
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Selecciona un chat para ver el panel
            </p>
          )}
        </section>
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalle</DialogTitle>
            <DialogDescription>
              Asignación, etiquetas y notas de la conversación
            </DialogDescription>
          </DialogHeader>
          {active ? (
            <ConversationSidePanel
              active={active}
              agents={agents}
              tags={tags}
              contactTags={contactTags}
              notes={notes}
              note={note}
              onNoteChange={setNote}
              onNotesChange={setNotes}
              onConversationsChange={setConversations}
              savingTagId={savingTagId}
              onSavingTagIdChange={setSavingTagId}
              onOpenTicket={() => {
                setDetailOpen(false);
                setTicketOpen(true);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={ticketOpen}
        onOpenChange={(open) => {
          setTicketOpen(open);
          if (!open) {
            setTicketTitle("");
            setTicketDescription("");
            setTicketPriority("medium");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Escalar a soporte</DialogTitle>
            <DialogDescription>
              Describe la incidencia. El ticket quedará en cola sin asignar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ticket-title">Título</Label>
              <Input
                id="ticket-title"
                value={ticketTitle}
                onChange={(e) => setTicketTitle(e.target.value)}
                placeholder="Resumen breve de la incidencia"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ticket-description">Descripción</Label>
              <Textarea
                id="ticket-description"
                value={ticketDescription}
                onChange={(e) => setTicketDescription(e.target.value)}
                placeholder="Detalle qué ocurrió, pasos y contexto útil para soporte"
                rows={4}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ticket-priority">Prioridad</Label>
              <Select
                id="ticket-priority"
                value={ticketPriority}
                onChange={(e) =>
                  setTicketPriority(e.target.value as TicketPriority)
                }
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setTicketOpen(false)}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                disabled={
                  pending ||
                  !ticketTitle.trim() ||
                  !ticketDescription.trim() ||
                  !active
                }
                onClick={() => {
                  if (!active) return;
                  startTransition(async () => {
                    try {
                      await createTicket({
                        companyId: active.company_id,
                        conversationId: active.id,
                        title: ticketTitle,
                        description: ticketDescription,
                        priority: ticketPriority,
                      });
                      setTicketOpen(false);
                      setTicketTitle("");
                      setTicketDescription("");
                      setTicketPriority("medium");
                      toast.success("Ticket creado", {
                        action: {
                          label: "Ver tickets",
                          onClick: () => {
                            router.push("/tickets");
                          },
                        },
                      });
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Error",
                      );
                    }
                  });
                }}
              >
                {pending ? "Creando…" : "Crear ticket"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
