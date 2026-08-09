"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Send } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WhatsAppText } from "@/components/conversations/whatsapp-text";
import { MessageStatusIcon } from "@/components/conversations/message-status-icon";
import type { MessageRow } from "@/lib/conversations/types";

const EmojiPicker = dynamic(
  () =>
    import("@/components/conversations/emoji-picker").then((m) => m.EmojiPicker),
  { ssr: false, loading: () => <span className="h-9 w-9" /> },
);

export function MessageThread({
  messages,
  loadingThread,
  loadingOlder,
  hasMore,
  onLoadOlder,
  canText,
  windowHint,
  text,
  onTextChange,
  onSend,
  onComposerKeyDown,
  composerRef,
  onInsertEmoji,
  onResizeComposer,
}: {
  messages: MessageRow[];
  loadingThread: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  canText: boolean;
  windowHint: string;
  text: string;
  onTextChange: (value: string) => void;
  onSend: () => void;
  onComposerKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onInsertEmoji: (emoji: string) => void;
  onResizeComposer: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 12,
    getItemKey: (index) => messages[index]?.id ?? index,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el || loadingThread) return;

    const grew = messages.length > prevCountRef.current;
    const prepended =
      grew &&
      prevCountRef.current > 0 &&
      messages[0]?.id !== undefined &&
      !stickToBottomRef.current;

    prevCountRef.current = messages.length;

    if (prepended) return;
    if (!stickToBottomRef.current && grew) return;

    requestAnimationFrame(() => {
      if (messages.length === 0) return;
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, loadingThread, virtualizer]);

  function handleScroll() {
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    if (el.scrollTop < 80 && hasMore && !loadingOlder) {
      onLoadOlder();
    }
  }

  return (
    <>
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="chat-thread min-h-0 flex-1 overflow-auto p-3 sm:p-4"
      >
        {loadingThread ? (
          <div className="space-y-2.5">
            <Skeleton className="h-14 w-2/3" />
            <Skeleton className="ml-auto h-14 w-1/2" />
            <Skeleton className="h-14 w-3/5" />
          </div>
        ) : (
          <>
            {hasMore ? (
              <div className="mb-3 flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingOlder}
                  onClick={onLoadOlder}
                  className="min-h-11 text-xs"
                >
                  {loadingOlder ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando…
                    </>
                  ) : (
                    "Cargar mensajes anteriores"
                  )}
                </Button>
              </div>
            ) : null}
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const m = messages[item.index]!;
                return (
                  <div
                    key={m.id}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${item.start}px)`,
                      paddingBottom: 10,
                    }}
                  >
                    <div
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
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <footer className="chat-composer-footer border-t border-[var(--line)] bg-[var(--surface)] px-3 py-3 sm:px-4">
        {!canText ? (
          <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {windowHint}. WhatsApp solo permite mensajes libres dentro de las
            24h desde el último mensaje entrante del contacto.
          </div>
        ) : null}
        <div className={`chat-composer ${!canText ? "opacity-60" : ""}`}>
          <EmojiPicker disabled={!canText} onPick={onInsertEmoji} />
          <Textarea
            ref={composerRef}
            className="chat-composer-input"
            rows={1}
            placeholder={
              canText
                ? "Escribe un mensaje"
                : "Chat bloqueado hasta que el contacto escriba"
            }
            value={text}
            onChange={(e) => {
              onTextChange(e.target.value);
              requestAnimationFrame(() => onResizeComposer());
            }}
            onKeyDown={onComposerKeyDown}
            disabled={!canText}
          />
          <Button
            type="button"
            size="icon"
            className="chat-composer-send"
            onClick={onSend}
            disabled={!canText || !text.trim()}
            aria-label="Enviar mensaje"
            title="Enviar (Enter)"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {canText ? (
          <p className="mt-1.5 px-1 text-[10px] text-[var(--muted)]">
            Enter envía · Shift+Enter salto de línea
          </p>
        ) : null}
      </footer>
    </>
  );
}
