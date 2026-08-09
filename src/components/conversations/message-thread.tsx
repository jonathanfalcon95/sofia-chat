"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Paperclip, Send, Square } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WhatsAppText } from "@/components/conversations/whatsapp-text";
import { MessageStatusIcon } from "@/components/conversations/message-status-icon";
import { MessageMedia } from "@/components/conversations/message-media";
import { validateOutboundFile } from "@/lib/media";
import { createVoiceRecorder } from "@/lib/voice-recorder";
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("audio/ogg");
  const tickRef = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [preparingMic, setPreparingMic] = useState(false);

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    bottomRef.current?.scrollIntoView({ block: "end", behavior });
  }

  useEffect(() => {
    if (loadingThread) return;
    const el = parentRef.current;
    if (!el) return;

    const firstId = messages[0]?.id ?? null;
    const grew = messages.length > prevCountRef.current;
    const prepended =
      grew &&
      prevCountRef.current > 0 &&
      firstId != null &&
      prevFirstIdRef.current != null &&
      firstId !== prevFirstIdRef.current;

    prevCountRef.current = messages.length;
    prevFirstIdRef.current = firstId;

    if (prepended) return;
    if (!stickToBottomRef.current && grew) return;

    const t0 = requestAnimationFrame(() => scrollToBottom());
    const t1 = window.setTimeout(() => scrollToBottom(), 50);
    const t2 = window.setTimeout(() => scrollToBottom(), 250);
    return () => {
      cancelAnimationFrame(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [messages, loadingThread]);

  useEffect(() => {
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
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

  function stopRecordingUi() {
    setRecording(false);
    setRecordSecs(0);
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  async function toggleRecording() {
    if (recording) {
      try {
        recorderRef.current?.stop();
      } catch {
        stopRecordingUi();
      }
      return;
    }
    if (preparingMic || mediaSending) return;

    try {
      setPreparingMic(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const { recorder, mimeType } = await createVoiceRecorder(stream);
      mimeRef.current = mimeType;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopRecordingUi();
        toast.error("Error al grabar audio");
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        stopRecordingUi();
        const blobType = mimeType.split(";")[0] || "audio/ogg";
        const blob = new Blob(chunksRef.current, { type: blobType });
        if (blob.size < 256) {
          toast.error("Grabación demasiado corta");
          return;
        }
        const file = new File([blob], `voice-${Date.now()}.ogg`, {
          type: "audio/ogg",
        });
        void onPickFile(file);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);
      setRecordSecs(0);
      tickRef.current = window.setInterval(() => {
        setRecordSecs((s) => s + 1);
      }, 1000);
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : "No se pudo acceder al micrófono",
      );
    } finally {
      setPreparingMic(false);
    }
  }

  const recordLabel = `${String(Math.floor(recordSecs / 60)).padStart(2, "0")}:${String(recordSecs % 60).padStart(2, "0")}`;

  const isMedia = (t: string) =>
    ["image", "audio", "video", "document", "sticker"].includes(t);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            <div className="flex flex-col gap-2.5">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`msg-bubble max-w-[min(85%,36rem)] px-3 py-2 text-[14.5px] leading-[1.4] ${
                    m.direction === "outbound"
                      ? "msg-out ml-auto"
                      : "msg-in"
                  }`}
                >
                  {isMedia(m.type) ? (
                    <MessageMedia
                      message={m}
                      onContentReady={() => {
                        if (stickToBottomRef.current) {
                          requestAnimationFrame(() => scrollToBottom());
                        }
                      }}
                    />
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
                    {m.template_name ? <span>· {m.template_name}</span> : null}
                    {m.direction === "outbound" ? (
                      <MessageStatusIcon status={m.status} />
                    ) : null}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} aria-hidden className="h-px w-full" />
            </div>
          </>
        )}
      </div>

      <footer className="chat-composer-footer shrink-0 border-t border-[var(--line)] bg-[var(--surface)] px-3 py-3 sm:px-4">
        {!canText ? (
          <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
            {windowHint}. WhatsApp solo permite mensajes libres dentro de las
            24h desde el último mensaje entrante del contacto.
          </div>
        ) : null}
        {recording ? (
          <div className="mb-2 flex items-center gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2.5">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-red-600 dark:text-red-300">
                Grabando nota de voz…
              </p>
              <p className="font-mono text-xs text-[var(--muted)]">
                {recordLabel} · toca el cuadrado para enviar
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              className="h-11 w-11 shrink-0 rounded-full bg-red-500 text-white hover:bg-red-600"
              aria-label="Detener y enviar nota de voz"
              onClick={() => void toggleRecording()}
            >
              <Square className="h-4 w-4 fill-current" />
            </Button>
          </div>
        ) : null}
        <div className={`chat-composer ${!canText || recording ? "opacity-60" : ""}`}>
          <EmojiPicker
            disabled={!canText || mediaSending || recording}
            onPick={onInsertEmoji}
          />
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
            disabled={!canText || mediaSending || recording || preparingMic}
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
            disabled={!canText || mediaSending || preparingMic}
            className={`h-9 w-9 shrink-0 rounded-full border-0 ${
              recording
                ? "bg-red-500/15 text-red-500"
                : "text-[var(--muted)]"
            }`}
            aria-label={recording ? "Detener grabación" : "Nota de voz"}
            title={recording ? "Detener y enviar" : "Nota de voz (OGG)"}
            onClick={() => void toggleRecording()}
          >
            {preparingMic ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : recording ? (
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
        {canText && !recording ? (
          <p className="mt-1.5 px-1 text-[10px] text-[var(--muted)]">
            Enter envía · Shift+Enter salto · micrófono nota de voz · clip
            imagen/PDF
          </p>
        ) : null}
      </footer>
    </div>
  );
}
