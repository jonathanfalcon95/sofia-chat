"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Mic, Paperclip, Send, Square } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WhatsAppText } from "@/components/conversations/whatsapp-text";
import { MessageStatusIcon } from "@/components/conversations/message-status-icon";
import { MessageMedia } from "@/components/conversations/message-media";
import { validateOutboundFile } from "@/lib/media";
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
  onSendMedia,
  mediaSending,
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
  onSendMedia: (file: File, caption?: string) => Promise<void>;
  mediaSending: boolean;
  onComposerKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onInsertEmoji: (emoji: string) => void;
  onResizeComposer: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
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

  useEffect(() => {
    return () => {
      recorderRef.current?.stop();
    };
  }, []);

  function handleScroll() {
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    if (el.scrollTop < 80 && hasMore && !loadingOlder) {
      onLoadOlder();
    }
  }

  async function onPickFile(file: File | null) {
    if (!file) return;
    const check = validateOutboundFile(file);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    try {
      await onSendMedia(file, text.trim() || undefined);
      onTextChange("");
      requestAnimationFrame(() => onResizeComposer());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo enviar");
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mime });
        const ext = mime.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `voice-${Date.now()}.${ext}`, {
          type: mime.split(";")[0],
        });
        void onPickFile(file);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      toast.error("No se pudo acceder al micrófono");
    }
  }

  const isMedia = (t: string) =>
    ["image", "audio", "video", "document", "sticker"].includes(t);

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
                      {isMedia(m.type) ? (
                        <MessageMedia message={m} />
                      ) : (
                        <div className="wa-text break-words whitespace-pre-wrap">
                          <WhatsAppText text={m.body} />
                        </div>
                      )}
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
          <EmojiPicker disabled={!canText || mediaSending} onPick={onInsertEmoji} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              void onPickFile(f);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!canText || mediaSending}
            className="h-9 w-9 shrink-0 rounded-full border-0 text-[var(--muted)]"
            aria-label="Adjuntar archivo"
            title="Imagen o PDF"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!canText || mediaSending}
            className={`h-9 w-9 shrink-0 rounded-full border-0 ${
              recording
                ? "bg-red-500/15 text-red-500"
                : "text-[var(--muted)]"
            }`}
            aria-label={recording ? "Detener grabación" : "Nota de voz"}
            title={recording ? "Detener" : "Nota de voz"}
            onClick={() => void toggleRecording()}
          >
            {recording ? (
              <Square className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
          <Textarea
            ref={composerRef}
            className="chat-composer-input"
            rows={1}
            placeholder={
              recording
                ? "Grabando nota de voz…"
                : canText
                  ? "Escribe un mensaje"
                  : "Chat bloqueado hasta que el contacto escriba"
            }
            value={text}
            onChange={(e) => {
              onTextChange(e.target.value);
              requestAnimationFrame(() => onResizeComposer());
            }}
            onKeyDown={onComposerKeyDown}
            disabled={!canText || mediaSending || recording}
          />
          <Button
            type="button"
            size="icon"
            className="chat-composer-send"
            onClick={onSend}
            disabled={!canText || !text.trim() || mediaSending || recording}
            aria-label="Enviar mensaje"
            title="Enviar (Enter)"
          >
            {mediaSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
        {canText ? (
          <p className="mt-1.5 px-1 text-[10px] text-[var(--muted)]">
            Enter envía · Shift+Enter salto · micrófono nota de voz · clip
            imagen/PDF
          </p>
        ) : null}
      </footer>
    </>
  );
}
