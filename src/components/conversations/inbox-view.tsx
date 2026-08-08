"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";
import {
  Check,
  CheckCheck,
  Clock,
  Filter,
  Loader2,
  Send,
  Ticket,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { isWithinCustomerWindow } from "@/lib/utils";
import {
  PRIORITY_LABELS,
  TICKET_PRIORITIES,
  type TicketPriority,
} from "@/lib/tickets";
import { useRealtimeInbox } from "@/hooks/use-realtime-inbox";
import {
  addConversationNote,
  assignConversation,
  createTicket,
  setConversationTag,
  startConversationWithTemplate,
} from "@/app/actions/conversations";
import { setContactTags } from "@/app/actions/tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiPicker } from "@/components/conversations/emoji-picker";
import { WhatsAppText } from "@/components/conversations/whatsapp-text";

type ContactTagRef = {
  tag_id: string;
  tags: { id: string; name: string; color: string } | null;
};

type ConversationRow = {
  id: string;
  company_id: string;
  inbox_id: string;
  contact_id?: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  window_expires_at: string | null;
  assignee_id: string | null;
  unread_count: number;
  contacts: {
    id: string;
    name: string | null;
    phone_number: string;
    contact_tags?: ContactTagRef[];
  } | null;
  inboxes: { name: string; phone_number: string } | null;
  conversation_tags: Array<{
    tag_id: string;
    tags: { id: string; name: string; color: string } | null;
  }>;
};

type MessageRow = {
  id: string;
  conversation_id?: string;
  direction: string;
  type: string;
  body: string | null;
  status: string;
  created_at: string;
  template_name: string | null;
};

type NoteRow = {
  id: string;
  body: string;
  created_at: string;
  profiles: { full_name: string | null; email: string } | null;
};

type AssigneeFilter = "all" | "mine" | "unassigned";

export function InboxView({
  initialConversations,
  agents,
  tags,
  contactTags = [],
  inboxes,
  selectedId,
  currentUserId,
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
  inboxes: Array<{
    id: string;
    name: string;
    phone_number: string;
    company_id: string;
  }>;
  selectedId?: string;
  currentUserId?: string;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState(
    selectedId || initialConversations[0]?.id,
  );
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templates, setTemplates] = useState<
    Array<{ name?: string; language?: string }>
  >([]);
  const [pending, startTransition] = useTransition();
  const [newPhone, setNewPhone] = useState("");
  const [newInboxId, setNewInboxId] = useState(inboxes[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketTitle, setTicketTitle] = useState("");
  const [ticketDescription, setTicketDescription] = useState("");
  const [ticketPriority, setTicketPriority] =
    useState<TicketPriority>("medium");
  const [filterContactTagId, setFilterContactTagId] = useState("");
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>("all");
  const [savingTagId, setSavingTagId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const companyAgents = useMemo(() => {
    if (!active) return agents;
    return agents.filter((a) => a.company_id === active.company_id);
  }, [agents, active]);

  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      if (
        filterContactTagId &&
        !c.contacts?.contact_tags?.some((t) => t.tag_id === filterContactTagId)
      ) {
        return false;
      }
      if (assigneeFilter === "mine") {
        return Boolean(currentUserId && c.assignee_id === currentUserId);
      }
      if (assigneeFilter === "unassigned") {
        return !c.assignee_id;
      }
      return true;
    });
  }, [
    conversations,
    filterContactTagId,
    assigneeFilter,
    currentUserId,
  ]);

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
    });
  }

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const reloadConversations = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversations")
      .select(
        `
        id, company_id, inbox_id, status, last_message_at, last_message_preview,
        window_expires_at, assignee_id, unread_count, contact_id,
        contacts (
          id, name, phone_number,
          contact_tags ( tag_id, tags ( id, name, color, is_kanban_column ) )
        ),
        inboxes ( name, phone_number ),
        conversation_tags ( tag_id, tags ( id, name, color ) )
      `,
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(100);

    const normalized =
      data?.map((c) => {
        const contact = Array.isArray(c.contacts) ? c.contacts[0] : c.contacts;
        const ctags = (
          (contact as { contact_tags?: Array<{ tag_id: string; tags: unknown }> } | null)
            ?.contact_tags ?? []
        )
          .map((ct) => ({
            tag_id: ct.tag_id,
            tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
          }))
          .filter(
            (ct) =>
              ct.tags &&
              !(ct.tags as { is_kanban_column?: boolean }).is_kanban_column,
          );
        return {
          ...c,
          contacts: contact
            ? {
                id: (contact as { id: string }).id,
                name: (contact as { name: string | null }).name,
                phone_number: (contact as { phone_number: string }).phone_number,
                contact_tags: ctags as ContactTagRef[],
              }
            : null,
          inboxes: Array.isArray(c.inboxes) ? c.inboxes[0] : c.inboxes,
          conversation_tags: (c.conversation_tags ?? []).map((ct) => ({
            tag_id: ct.tag_id,
            tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
          })),
        };
      }) ?? [];
    setConversations(normalized as ConversationRow[]);
  }, []);

  const onMessage = useCallback((msg: MessageRow) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      // Replace optimistic pending bubble if realtime/API already delivered it
      const withoutDupPending = prev.filter(
        (m) =>
          !(
            m.id.startsWith("temp-") &&
            m.direction === "outbound" &&
            msg.direction === "outbound" &&
            m.body === msg.body
          ),
      );
      return [...withoutDupPending, msg];
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
          void reloadConversations();
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
    [activeId, reloadConversations],
  );

  useRealtimeInbox({
    activeConversationId: activeId,
    onMessage,
    onConversationChange,
    onReloadConversations: reloadConversations,
  });

  useEffect(() => {
    if (!activeId) return;
    const supabase = createClient();
    let cancelled = false;

    async function load() {
      setLoadingThread(true);
      const [{ data: msgs }, { data: noteRows }] = await Promise.all([
        supabase
          .from("messages")
          .select(
            "id, direction, type, body, status, created_at, template_name, conversation_id",
          )
          .eq("conversation_id", activeId)
          .order("created_at", { ascending: true }),
        supabase
          .from("conversation_notes")
          .select("id, body, created_at, profiles(full_name, email)")
          .eq("conversation_id", activeId)
          .order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      setMessages((msgs as MessageRow[]) ?? []);
      setNotes(
        (noteRows as unknown as NoteRow[])?.map((n) => ({
          ...n,
          profiles: Array.isArray(n.profiles) ? n.profiles[0] : n.profiles,
        })) ?? [],
      );
      await supabase
        .from("conversations")
        .update({ unread_count: 0 })
        .eq("id", activeId);
      setConversations((prev) =>
        prev.map((c) => (c.id === activeId ? { ...c, unread_count: 0 } : c)),
      );
      setLoadingThread(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((data) => {
        const items = Array.isArray(data.items) ? data.items : [];
        setTemplates(
          items.map((t: Record<string, unknown>) => ({
            name: String(t.name ?? t.templateName ?? ""),
            language:
              typeof t.language === "string"
                ? t.language
                : String(
                    (t.language as { code?: string } | undefined)?.code ?? "es",
                  ),
          })),
        );
      })
      .catch(() => setTemplates([]));
  }, []);

  const canText = isWithinCustomerWindow(active?.window_expires_at);

  function focusComposer() {
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
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

  async function sendTemplate() {
    if (!active || !templateName.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: active.id,
          mode: "template",
          templateName,
          languageCode: "es",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al enviar");
      if (data.message) {
        setMessages((prev) =>
          prev.some((m) => m.id === data.message.id)
            ? prev
            : [...prev, data.message],
        );
      }
      toast.success("Plantilla enviada");
      focusComposer();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo enviar");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    const node = messagesEndRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: loadingThread ? "auto" : "smooth" });
  }, [messages, loadingThread, activeId]);

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canText && text.trim()) {
        sendTextOptimistic();
      }
    }
  }

  function MessageStatusIcon({ status }: { status: string }) {
    const s = status.toLowerCase();
    if (s === "pending") {
      return <Clock className="h-3 w-3 opacity-80" aria-label="Enviando" />;
    }
    if (s === "failed" || s === "error") {
      return <X className="h-3 w-3 text-red-300" aria-label="Falló" />;
    }
    if (s === "read") {
      return <CheckCheck className="h-3.5 w-3.5 text-sky-200" aria-label="Leído" />;
    }
    if (s === "delivered") {
      return <CheckCheck className="h-3.5 w-3.5 opacity-80" aria-label="Entregado" />;
    }
    return <Check className="h-3 w-3 opacity-80" aria-label="Enviado" />;
  }

  return (
    <div className="-m-5">
      <div className="chat-layout">
        <section className="chat-pane">
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
                    className="h-7 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1 text-xs text-[var(--muted)] outline-none hover:border-[var(--line)] hover:bg-[var(--surface-2)] focus:border-[var(--line)] focus:bg-[var(--surface-2)]"
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
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                    assigneeFilter === opt.id
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
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
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
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
            <Select
              value={newInboxId}
              onChange={(e) => setNewInboxId(e.target.value)}
            >
              {inboxes.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.phone_number})
                </option>
              ))}
            </Select>
            <Input
              placeholder="Teléfono +58..."
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
            <Input
              placeholder="Plantilla para iniciar"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              list="template-list"
            />
            <datalist id="template-list">
              {templates.map((t) => (
                <option key={`${t.name}-${t.language}`} value={t.name} />
              ))}
            </datalist>
            <Button
              className="w-full"
              loading={pending}
              disabled={!newPhone || !templateName}
              onClick={() =>
                startTransition(async () => {
                  try {
                    const result = await startConversationWithTemplate({
                      inboxId: newInboxId,
                      contactPhone: newPhone,
                      templateName,
                    });
                    const res = await fetch("/api/messages/send", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        conversationId: result.conversationId,
                        mode: "template",
                        templateName,
                        languageCode: "es",
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error);
                    toast.success("Chat iniciado");
                    setActiveId(result.conversationId);
                    await reloadConversations();
                  } catch (e) {
                    toast.error(
                      e instanceof Error ? e.message : "No se pudo iniciar",
                    );
                  }
                })
              }
            >
              Iniciar con plantilla
            </Button>
          </div>

          <div className="flex-1 overflow-auto">
            {filteredConversations.length === 0 ? (
              <div className="p-6 text-sm text-[var(--muted)]">
                Sin conversaciones aún
              </div>
            ) : (
              filteredConversations.map((c) => {
                const contact = c.contacts;
                const tag = c.conversation_tags?.[0]?.tags;
                const activeRow = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    className={`w-full border-b border-[var(--line)] px-4 py-3 text-left transition ${
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

        <section className="chat-pane">
          {active ? (
            <>
              <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
                <div>
                  <h2 className="text-base font-bold">
                    {active.contacts?.name || active.contacts?.phone_number}
                  </h2>
                  <p className="text-xs text-[var(--muted)]">
                    {active.contacts?.phone_number} · {active.inboxes?.name}
                  </p>
                </div>
                <Badge
                  className={
                    canText
                      ? "border-emerald-500/30 text-emerald-400"
                      : "border-amber-500/30 text-amber-400"
                  }
                >
                  {canText ? "Ventana 24h abierta" : "Ventana 24h cerrada"}
                </Badge>
              </header>

              <div
                ref={messagesScrollRef}
                className="flex-1 space-y-3 overflow-auto p-4"
              >
                {loadingThread ? (
                  <>
                    <Skeleton className="h-14 w-2/3" />
                    <Skeleton className="ml-auto h-14 w-1/2" />
                    <Skeleton className="h-14 w-3/5" />
                  </>
                ) : (
                  <>
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={`msg-bubble max-w-[min(85%,36rem)] px-3 py-2 text-[14.5px] leading-[1.4] ${
                          m.direction === "outbound"
                            ? "msg-out ml-auto"
                            : "msg-in"
                        }`}
                      >
                        <div className="wa-text break-words whitespace-pre-wrap">
                          <WhatsAppText text={m.body} />
                        </div>
                        <div
                          className={`mt-1 flex items-center justify-end gap-1 text-[10px] leading-none ${
                            m.direction === "outbound"
                              ? "text-white/70"
                              : "text-[var(--muted)]"
                          }`}
                        >
                          <span>
                            {new Date(m.created_at).toLocaleTimeString("es", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {m.template_name ? (
                            <span>· {m.template_name}</span>
                          ) : null}
                          {m.direction === "outbound" ? (
                            <MessageStatusIcon status={m.status} />
                          ) : null}
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>

              <footer className="space-y-2 border-t border-[var(--line)] p-4">
                <div className="flex items-start gap-2">
                  <EmojiPicker disabled={!canText} onPick={insertEmoji} />
                  <Textarea
                    ref={composerRef}
                    className="flex-1"
                    rows={3}
                    placeholder={
                      canText
                        ? "Escribe un mensaje... (Enter envía, Shift+Enter salto de línea)"
                        : "Fuera de ventana: usa plantilla"
                    }
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={!canText}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => sendTextOptimistic()}
                    disabled={!canText || !text.trim()}
                  >
                    <Send className="h-4 w-4" /> Enviar
                  </Button>
                  <Input
                    className="min-w-[160px] flex-1"
                    placeholder="Nombre plantilla"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    list="template-list"
                  />
                  <Button
                    variant="secondary"
                    disabled={!templateName || sending}
                    loading={sending}
                    onClick={() => void sendTemplate()}
                  >
                    Plantilla
                  </Button>
                </div>
              </footer>
            </>
          ) : (
            <div className="m-auto flex items-center gap-2 text-[var(--muted)]">
              <Loader2 className="h-4 w-4" /> Selecciona una conversación
            </div>
          )}
        </section>

        <section className="chat-pane chat-pane-side overflow-auto p-4">
          <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-[var(--muted)]">
            Panel
          </h3>
          {active ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Asignar agente</Label>
                <Select
                  value={active.assignee_id ?? ""}
                  onChange={(e) =>
                    startTransition(async () => {
                      try {
                        await assignConversation(
                          active.id,
                          e.target.value || null,
                        );
                        setConversations((prev) =>
                          prev.map((c) =>
                            c.id === active.id
                              ? { ...c, assignee_id: e.target.value || null }
                              : c,
                          ),
                        );
                        toast.success("Conversación asignada");
                      } catch (err) {
                        toast.error(
                          err instanceof Error ? err.message : "Error",
                        );
                      }
                    })
                  }
                >
                  <option value="">Sin asignar</option>
                  {companyAgents.map((a) => (
                    <option key={`${a.company_id}-${a.id}`} value={a.id}>
                      {a.full_name || a.email}
                    </option>
                  ))}
                </Select>
                <p className="text-[11px] text-[var(--muted)]">
                  Solo agentes de esta empresa
                </p>
              </div>

              <div className="space-y-2">
                <Label>Etiqueta / Kanban</Label>
                <Select
                  value={active.conversation_tags?.[0]?.tag_id ?? ""}
                  onChange={(e) =>
                    startTransition(async () => {
                      try {
                        await setConversationTag(active.id, e.target.value);
                        const tag = tags.find((t) => t.id === e.target.value);
                        setConversations((prev) =>
                          prev.map((c) =>
                            c.id === active.id
                              ? {
                                  ...c,
                                  conversation_tags: tag
                                    ? [
                                        {
                                          tag_id: tag.id,
                                          tags: {
                                            id: tag.id,
                                            name: tag.name,
                                            color: tag.color,
                                          },
                                        },
                                      ]
                                    : c.conversation_tags,
                                }
                              : c,
                          ),
                        );
                        toast.success("Etiqueta actualizada");
                      } catch (err) {
                        toast.error(
                          err instanceof Error ? err.message : "Error",
                        );
                      }
                    })
                  }
                >
                  <option value="" disabled>
                    Seleccionar
                  </option>
                  {tags
                    .filter((t) => t.company_id === active.company_id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </Select>
              </div>

              {active.contacts?.id ? (
                <div className="space-y-2">
                  <Label>Tags del contacto</Label>
                  <div className="space-y-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2">
                    {contactTags
                      .filter((t) => t.company_id === active.company_id)
                      .map((t) => {
                        const checked = Boolean(
                          active.contacts?.contact_tags?.some(
                            (ct) => ct.tag_id === t.id,
                          ),
                        );
                        const busy = savingTagId === t.id;
                        return (
                          <label
                            key={t.id}
                            className={`flex items-center gap-2 text-sm ${
                              busy
                                ? "cursor-wait opacity-70"
                                : "cursor-pointer"
                            }`}
                          >
                            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                              {busy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                              ) : (
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5"
                                  checked={checked}
                                  disabled={Boolean(savingTagId)}
                                  onChange={(e) => {
                                    const contactId = active.contacts!.id;
                                    const current =
                                      active.contacts?.contact_tags?.map(
                                        (ct) => ct.tag_id,
                                      ) ?? [];
                                    const next = e.target.checked
                                      ? [...current, t.id]
                                      : current.filter((id) => id !== t.id);
                                    const previous =
                                      active.contacts?.contact_tags ?? [];
                                    const selected = contactTags
                                      .filter((ct) => next.includes(ct.id))
                                      .map((ct) => ({
                                        tag_id: ct.id,
                                        tags: {
                                          id: ct.id,
                                          name: ct.name,
                                          color: ct.color,
                                        },
                                      }));
                                    // Optimistic UI
                                    setConversations((prev) =>
                                      prev.map((c) =>
                                        c.contacts?.id === contactId
                                          ? {
                                              ...c,
                                              contacts: c.contacts
                                                ? {
                                                    ...c.contacts,
                                                    contact_tags: selected,
                                                  }
                                                : c.contacts,
                                            }
                                          : c,
                                      ),
                                    );
                                    setSavingTagId(t.id);
                                    void (async () => {
                                      try {
                                        await setContactTags(contactId, next);
                                        toast.success("Tags actualizados");
                                      } catch (err) {
                                        setConversations((prev) =>
                                          prev.map((c) =>
                                            c.contacts?.id === contactId
                                              ? {
                                                  ...c,
                                                  contacts: c.contacts
                                                    ? {
                                                        ...c.contacts,
                                                        contact_tags: previous,
                                                      }
                                                    : c.contacts,
                                                }
                                              : c,
                                          ),
                                        );
                                        toast.error(
                                          err instanceof Error
                                            ? err.message
                                            : "Error",
                                        );
                                      } finally {
                                        setSavingTagId(null);
                                      }
                                    })();
                                  }}
                                />
                              )}
                            </span>
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ background: t.color }}
                            />
                            {t.name}
                          </label>
                        );
                      })}
                    {contactTags.filter(
                      (t) => t.company_id === active.company_id,
                    ).length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">
                        No hay tags. Créalos en Contactos.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label>Nota interna</Label>
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={!note || pending}
                  onClick={() =>
                    startTransition(async () => {
                      try {
                        await addConversationNote(
                          active.id,
                          active.company_id,
                          note,
                        );
                        setNote("");
                        toast.success("Nota guardada");
                        const supabase = createClient();
                        const { data: noteRows } = await supabase
                          .from("conversation_notes")
                          .select(
                            "id, body, created_at, profiles(full_name, email)",
                          )
                          .eq("conversation_id", active.id)
                          .order("created_at", { ascending: false });
                        setNotes(
                          (noteRows as unknown as NoteRow[])?.map((n) => ({
                            ...n,
                            profiles: Array.isArray(n.profiles)
                              ? n.profiles[0]
                              : n.profiles,
                          })) ?? [],
                        );
                      } catch (err) {
                        toast.error(
                          err instanceof Error ? err.message : "Error",
                        );
                      }
                    })
                  }
                >
                  Guardar nota
                </Button>
              </div>

              <div className="space-y-2">
                {notes.map((n) => (
                  <div
                    key={n.id}
                    className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs"
                  >
                    <strong>
                      {n.profiles?.full_name || n.profiles?.email}
                    </strong>
                    <p className="mt-1">{n.body}</p>
                  </div>
                ))}
              </div>

              <div className="border-t border-[var(--line)] pt-4">
                <button
                  type="button"
                  onClick={() => setTicketOpen(true)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)] transition hover:border-[var(--accent)]/40 hover:bg-[var(--accent-soft)]/40 hover:text-[var(--ink)]"
                >
                  <Ticket className="h-3.5 w-3.5" />
                  Escalar a soporte
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Selecciona un chat para ver el panel
            </p>
          )}
        </section>
      </div>

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
                            window.location.href = "/tickets";
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
