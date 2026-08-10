"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Mic,
  Paperclip,
  Reply,
  Send,
  SmilePlus,
  Square,
  X,
} from "lucide-react";
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

const SofiaCommandsHelp = dynamic(
  () =>
    import("@/components/conversations/sofia-commands-help").then(
      (m) => m.SofiaCommandsHelp,
    ),
  { ssr: false, loading: () => <span className="h-9 w-9" /> },
);

const REACTION_SET = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

function isMedia(type: string) {
  return ["image", "audio", "video", "document", "sticker"].includes(type);
}

function messageWamid(m: MessageRow) {
  if (m.wamid) return m.wamid;
  if (m.ycloud_message_id?.startsWith("wamid.")) return m.ycloud_message_id;
  return null;
}

export function MessageThread({
  activeConversationId,
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
  onSendCommand,
  onSendMedia,
  mediaSending,
  onComposerKeyDown,
  composerRef,
  onInsertEmoji,
  onResizeComposer,
  onFirstPaint,
  replyTo,
  onReplyTo,
  onReact,
}: {
  activeConversationId: string;
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
  onSendCommand: (command: string) => void;
  onSendMedia: (file: File, caption?: string) => Promise<void>;
  mediaSending: boolean;
  onComposerKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onInsertEmoji: (emoji: string) => void;
  onResizeComposer: () => void;
  onFirstPaint?: (conversationId: string) => void;
  replyTo: MessageRow | null;
  onReplyTo: (message: MessageRow | null) => void;
  onReact: (message: MessageRow, emoji: string) => void;
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
  const firstPaintDoneForConversationRef = useRef<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [preparingMic, setPreparingMic] = useState(false);
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null);
  const [reactPickerId, setReactPickerId] = useState<string | null>(null);
  const firstMessageId = messages[0]?.id;
  const lastMessageId = messages[messages.length - 1]?.id;

  const byWamid = useMemo(() => {
    const map = new Map<string, MessageRow>();
    for (const m of messages) {
      const id = messageWamid(m);
      if (id) map.set(id, m);
    }
    return map;
  }, [messages]);

  function scrollToBottom() {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    if (loadingThread) return;
    if (messages.length === 0) return;

    const firstId = firstMessageId ?? null;
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
    return () => cancelAnimationFrame(t0);
  }, [firstMessageId, lastMessageId, loadingThread, messages.length]);

  useEffect(() => {
    if (!activeConversationId) return;
    if (loadingThread) return;
    if (firstPaintDoneForConversationRef.current === activeConversationId) return;
    firstPaintDoneForConversationRef.current = activeConversationId;
    const frame = requestAnimationFrame(() => onFirstPaint?.(activeConversationId));
    return () => cancelAnimationFrame(frame);
  }, [activeConversationId, loadingThread, onFirstPaint]);

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
          type: blobType,
        });
        void onPickFile(file);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setPreparingMic(false);
      setRecording(true);
      setRecordSecs(0);
      tickRef.current = window.setInterval(
        () => setRecordSecs((s) => s + 1),
        1000,
      );
    } catch {
      setPreparingMic(false);
      toast.error("No se pudo acceder al micrófono");
    }
  }

  const recordLabel = `${String(Math.floor(recordSecs / 60)).padStart(2, "0")}:${String(
    recordSecs % 60,
  ).padStart(2, "0")}`;

  function quotedPreview(m: MessageRow) {
    return (m.body || m.template_name || m.type || "Mensaje").slice(0, 120);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="chat-thread-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
      >
        {loadingThread ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-12 w-2/3 rounded-2xl" />
            <Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" />
            <Skeleton className="h-16 w-3/5 rounded-2xl" />
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
              {messages.map((m) => {
                const media = isMedia(m.type);
                const quoted = m.reply_to_wamid
                  ? byWamid.get(m.reply_to_wamid)
                  : null;
                const reactions = Array.isArray(m.reactions) ? m.reactions : [];
                const ourReaction = reactions.find((r) => r.direction === "outbound");
                const showMenu = menuMessageId === m.id;
                const showReact = reactPickerId === m.id;

                return (
                  <div
                    key={m.id}
                    className={`group relative flex flex-col ${
                      m.direction === "outbound" ? "items-end" : "items-start"
                    }`}
                    onMouseLeave={() => {
                      if (menuMessageId === m.id) setMenuMessageId(null);
                      if (reactPickerId === m.id) setReactPickerId(null);
                    }}
                  >
                    <div
                      className={`msg-bubble text-[14.5px] leading-[1.4] ${
                        media
                          ? `msg-bubble-media ${
                              m.type === "audio"
                                ? "msg-bubble-audio"
                                : m.type === "document"
                                  ? "msg-bubble-doc"
                                  : m.type === "sticker"
                                    ? "msg-bubble-sticker"
                                    : ""
                            }`
                          : "px-3 py-2"
                      } ${m.direction === "outbound" ? "msg-out" : "msg-in"}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenuMessageId(m.id);
                        setReactPickerId(null);
                      }}
                    >
                      {m.reply_to_wamid ? (
                        <div
                          className={`mb-1.5 rounded-md border-l-2 px-2 py-1 text-[12px] ${
                            m.direction === "outbound"
                              ? "border-white/50 bg-black/10 text-white/85"
                              : "border-[var(--accent)] bg-[var(--surface-2)] text-[var(--muted)]"
                          }`}
                        >
                          {quoted ? quotedPreview(quoted) : "Mensaje citado"}
                        </div>
                      ) : null}
                      {media ? (
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
                        className={`mt-1 flex items-center justify-end gap-1 px-1 text-[10px] leading-none ${
                          m.direction === "outbound"
                            ? "text-white/70"
                            : "text-[var(--muted)]"
                        } ${m.type === "sticker" ? "px-0 text-[var(--muted)]" : ""}`}
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

                    {reactions.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1 px-1">
                        {Object.entries(
                          reactions.reduce<Record<string, number>>((acc, r) => {
                            acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
                            return acc;
                          }, {}),
                        ).map(([emoji, count]) => (
                          <button
                            key={emoji}
                            type="button"
                            disabled={!canText}
                            onClick={() => {
                              if (ourReaction?.emoji === emoji) {
                                onReact(m, "");
                              } else {
                                onReact(m, emoji);
                              }
                            }}
                            className={`rounded-full border px-1.5 py-0.5 text-xs ${
                              ourReaction?.emoji === emoji
                                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                                : "border-[var(--line)] bg-[var(--surface)]"
                            }`}
                          >
                            {emoji}
                            {count > 1 ? ` ${count}` : ""}
                          </button>
                        ))}
                      </div>
                    ) : null}

                    <div
                      className={`mt-1 flex gap-1 opacity-0 transition group-hover:opacity-100 ${
                        showMenu || showReact ? "opacity-100" : ""
                      }`}
                    >
                      <button
                        type="button"
                        disabled={!canText}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-[11px] text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-40"
                        onClick={() => {
                          onReplyTo(m);
                          setMenuMessageId(null);
                          composerRef.current?.focus();
                        }}
                      >
                        <Reply className="h-3 w-3" />
                        Responder
                      </button>
                      <button
                        type="button"
                        disabled={!canText || !messageWamid(m)}
                        title={
                          messageWamid(m)
                            ? "Reaccionar"
                            : "Espera a que WhatsApp asigne wamid"
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 text-[11px] text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-40"
                        onClick={() => {
                          setReactPickerId((id) => (id === m.id ? null : m.id));
                          setMenuMessageId(null);
                        }}
                      >
                        <SmilePlus className="h-3 w-3" />
                        Reaccionar
                      </button>
                    </div>

                    {showReact ? (
                      <div className="mt-1 flex gap-1 rounded-full border border-[var(--line)] bg-[var(--surface)] p-1 shadow-sm">
                        {REACTION_SET.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            className="h-8 w-8 rounded-full text-base hover:bg-[var(--accent-soft)]"
                            onClick={() => {
                              onReact(m, emoji);
                              setReactPickerId(null);
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
        {replyTo ? (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
            <div className="min-w-0 flex-1 border-l-2 border-[var(--accent)] pl-2">
              <p className="text-[11px] font-semibold text-[var(--accent)]">
                Respondiendo
              </p>
              <p className="truncate text-xs text-[var(--muted)]">
                {quotedPreview(replyTo)}
              </p>
            </div>
            <button
              type="button"
              aria-label="Cancelar respuesta"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--surface)]"
              onClick={() => onReplyTo(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
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
          <SofiaCommandsHelp
            disabled={!canText || mediaSending || recording}
            onSelect={onSendCommand}
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
              recording ? "bg-red-500/15 text-red-500" : "text-[var(--muted)]"
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
          <p className="mt-1.5 text-[10px] text-[var(--muted)]">
            Enter envía · Shift+Enter salto · ? comandos Sofia · micrófono nota
            de voz · clip imagen/PDF
          </p>
        ) : null}
      </footer>
    </div>
  );
}
