"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { InboxNotifyDetail } from "@/lib/sofia-notify";

type NotificationItem = {
  id: string;
  type: "assignment" | "message";
  title: string;
  body: string;
  conversationId: string;
  createdAt: string;
  read: boolean;
};

export function NotificationBell({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [live, setLive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const assigneeCache = useRef<Map<string, string | null>>(new Map());
  const seenIds = useRef<Set<string>>(new Set());

  const unread = items.filter((i) => !i.read).length;

  const push = useCallback(
    (item: Omit<NotificationItem, "read">, opts?: { toast?: boolean }) => {
      if (seenIds.current.has(item.id)) return;
      seenIds.current.add(item.id);
      setItems((prev) => [{ ...item, read: false }, ...prev].slice(0, 40));
      if (opts?.toast !== false) {
        toast.message(item.title, {
          description: item.body,
          action: {
            label: "Abrir",
            onClick: () => {
              window.location.href = `/conversations/${item.conversationId}`;
            },
          },
        });
      }
    },
    [],
  );

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Bridge from inbox realtime (backup path)
  useEffect(() => {
    function onNotify(e: WindowEventMap["sofia:notify"]) {
      const d = e.detail;
      if (d.type === "assignment") {
        if (d.assigneeId !== userId || d.previousAssigneeId === userId) return;
        push({
          id: `assign-${d.conversationId}-${d.createdAt || Date.now()}`,
          type: "assignment",
          title: "Chat asignado",
          body: d.body || "Te asignaron una conversación",
          conversationId: d.conversationId,
          createdAt: d.createdAt || new Date().toISOString(),
        });
        return;
      }
      if (!d.messageId || !d.conversationId) return;
      push({
        id: `msg-${d.messageId}`,
        type: "message",
        title:
          d.assigneeId === userId
            ? "Nuevo mensaje"
            : "Nuevo mensaje entrante",
        body: (d.body || "Nuevo mensaje").slice(0, 120),
        conversationId: d.conversationId,
        createdAt: d.createdAt || new Date().toISOString(),
      });
    }
    window.addEventListener("sofia:notify", onNotify);
    return () => window.removeEventListener("sofia:notify", onNotify);
  }, [userId, push]);

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const notifyInbound = async (
      conversationId: string,
      msg: {
        id: string;
        body?: string | null;
        created_at?: string;
        direction?: string;
      },
    ) => {
      if (msg.direction && msg.direction !== "inbound") return;

      let assignee = assigneeCache.current.get(conversationId);
      if (assignee === undefined) {
        const { data } = await supabase
          .from("conversations")
          .select("assignee_id")
          .eq("id", conversationId)
          .maybeSingle();
        assignee = (data?.assignee_id as string | null) ?? null;
        assigneeCache.current.set(conversationId, assignee);
      }

      // Notify all inbound the user can see (RLS). Prefer clearer copy for own chats.
      push({
        id: `msg-${msg.id}`,
        type: "message",
        title:
          assignee === userId
            ? "Nuevo mensaje"
            : assignee
              ? "Nuevo mensaje en el inbox"
              : "Nuevo mensaje (sin asignar)",
        body: (msg.body || "Nuevo mensaje").slice(0, 120),
        conversationId,
        createdAt: msg.created_at || new Date().toISOString(),
      });
    };

    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (cancelled) return;
      if (sessionData.session?.access_token) {
        supabase.realtime.setAuth(sessionData.session.access_token);
      }

      const { data: convs } = await supabase
        .from("conversations")
        .select("id, assignee_id")
        .limit(300);
      if (cancelled) return;
      for (const row of convs ?? []) {
        assigneeCache.current.set(
          row.id as string,
          (row.assignee_id as string | null) ?? null,
        );
      }

      channel = supabase
        .channel(`sofia-notifications-${userId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "conversations" },
          async (payload) => {
            const row = payload.new as {
              id?: string;
              assignee_id?: string | null;
              last_message_preview?: string | null;
              last_message_at?: string | null;
            };
            const old = payload.old as {
              assignee_id?: string | null;
              last_message_at?: string | null;
            };
            if (!row?.id) return;

            const prevAssignee =
              old?.assignee_id ?? assigneeCache.current.get(row.id) ?? null;
            assigneeCache.current.set(row.id, row.assignee_id ?? null);

            if (row.assignee_id === userId && prevAssignee !== userId) {
              push({
                id: `assign-${row.id}-${Date.now()}`,
                type: "assignment",
                title: "Chat asignado",
                body:
                  row.last_message_preview || "Te asignaron una conversación",
                conversationId: row.id,
                createdAt: new Date().toISOString(),
              });
            }

            // Fallback: conversation bumped — fetch latest inbound message
            if (
              row.last_message_at &&
              row.last_message_at !== old?.last_message_at
            ) {
              const { data: latest } = await supabase
                .from("messages")
                .select("id, body, created_at, direction")
                .eq("conversation_id", row.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (latest?.direction === "inbound" && latest.id) {
                await notifyInbound(row.id, latest);
              }
            }
          },
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          async (payload) => {
            const msg = payload.new as {
              id?: string;
              conversation_id?: string;
              direction?: string;
              body?: string | null;
              created_at?: string;
            };
            if (!msg?.id || !msg.conversation_id) return;
            if (msg.direction !== "inbound") return;
            await notifyInbound(msg.conversation_id, {
              id: msg.id,
              body: msg.body,
              created_at: msg.created_at,
              direction: msg.direction,
            });
          },
        )
        .subscribe((status) => {
          if (!cancelled) setLive(status === "SUBSCRIBED");
        });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [userId, push]);

  // Safety net: poll recent inbound while the tab is open (covers Realtime gaps)
  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    let lastSeen = new Date().toISOString();

    const tick = async () => {
      const { data } = await supabase
        .from("messages")
        .select("id, conversation_id, body, created_at, direction")
        .eq("direction", "inbound")
        .gt("created_at", lastSeen)
        .order("created_at", { ascending: true })
        .limit(20);
      if (!data?.length) return;
      lastSeen = data[data.length - 1]!.created_at as string;
      for (const msg of data) {
        if (!msg.conversation_id || !msg.id) continue;
        push({
          id: `msg-${msg.id}`,
          type: "message",
          title: "Nuevo mensaje entrante",
          body: (msg.body || "Nuevo mensaje").slice(0, 120),
          conversationId: msg.conversation_id as string,
          createdAt: (msg.created_at as string) || new Date().toISOString(),
        });
      }
    };

    const id = window.setInterval(() => {
      void tick();
    }, 8000);
    return () => window.clearInterval(id);
  }, [userId, push]);

  function markAllRead() {
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) markAllRead();
        }}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] hover:bg-[var(--accent-soft)]"
        aria-label="Notificaciones"
        title={live ? "Notificaciones en vivo" : "Conectando notificaciones…"}
      >
        <Bell className="h-4 w-4" />
        <span
          className={cn(
            "absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full",
            live ? "bg-emerald-400" : "bg-amber-400",
          )}
        />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-[320px] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-2">
            <span className="text-sm font-semibold">Notificaciones</span>
            <button
              type="button"
              className="text-xs text-[var(--muted)] hover:text-[var(--ink)]"
              onClick={markAllRead}
            >
              Marcar leídas
            </button>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {items.length === 0 ? (
              <p className="p-4 text-sm text-[var(--muted)]">
                Sin notificaciones recientes
                {!live ? " · reconectando…" : ""}
              </p>
            ) : (
              items.map((item) => (
                <Link
                  key={item.id}
                  href={`/conversations/${item.conversationId}`}
                  onClick={() => {
                    setItems((prev) =>
                      prev.map((p) =>
                        p.id === item.id ? { ...p, read: true } : p,
                      ),
                    );
                    setOpen(false);
                  }}
                  className={cn(
                    "block border-b border-[var(--line)] px-3 py-2.5 hover:bg-[var(--surface-2)]",
                    !item.read && "bg-[var(--accent-soft)]/40",
                  )}
                >
                  <div className="text-xs font-semibold">{item.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">
                    {item.body}
                  </div>
                  <div className="mt-1 text-[10px] text-[var(--muted)]">
                    {new Date(item.createdAt).toLocaleTimeString("es", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
