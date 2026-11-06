"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Mic,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { validateOutboundFile } from "@/lib/media";
import { createVoiceRecorder } from "@/lib/voice-recorder";
import { whatsappDeepLink } from "@/lib/conversations/phone-digits";
import type { SofiaControlAction } from "@/components/conversations/sofia-commands-help";

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

/** Unsent text per conversation, for this tab's lifetime. */
const drafts = new Map<string, string>();

function fitToContent(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 136)}px`;
}

/**
 * Mount with key={conversationId}: text and any voice recording belong to one
 * chat and must never carry over to another.
 */
export function MessageComposer({
  conversationId,
  canText,
  windowHint,
  contactPhone,
  onSendText,
  onSendMedia,
  mediaSending,
  onSofiaAction,
  sofiaPending = null,
  sofiaStoppedAll = false,
  sofiaChatPaused = false,
  composerRef,
  replyPreview,
  onCancelReply,
}: {
  conversationId: string;
  canText: boolean;
  windowHint: string;
  contactPhone?: string | null;
  /** Returns false when the message was rejected, to keep the typed text. */
  onSendText: (text: string) => boolean;
  onSendMedia: (file: File, caption?: string) => Promise<void>;
  mediaSending: boolean;
  onSofiaAction: (action: SofiaControlAction) => void;
  sofiaPending?: SofiaControlAction | null;
  sofiaStoppedAll?: boolean;
  sofiaChatPaused?: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  replyPreview: string | null;
  onCancelReply: () => void;
}) {
  const [text, setText] = useState(() => drafts.get(conversationId) ?? "");
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [preparingMic, setPreparingMic] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<number | null>(null);
  const whatsappUrl = whatsappDeepLink(contactPhone);
  const hasText = text.trim().length > 0;

  function updateText(next: string) {
    setText(next);
    if (next) drafts.set(conversationId, next);
    else drafts.delete(conversationId);
    requestAnimationFrame(() => fitToContent(composerRef.current));
  }

  // Fit a restored draft; an empty field already is one row tall.
  useEffect(() => {
    if (!drafts.has(conversationId)) return;
    const frame = requestAnimationFrame(() =>
      fitToContent(composerRef.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [composerRef, conversationId]);

  useEffect(() => {
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
      // Leaving the chat discards the recording rather than sending it to
      // whichever chat is open by the time it stops.
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function send() {
    if (!canText || !hasText) return;
    if (onSendText(text)) {
      updateText("");
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }

  function insertEmoji(emoji: string) {
    const el = composerRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    updateText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + emoji.length;
      el?.setSelectionRange(pos, pos);
    });
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
      updateText("");
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
        recorderRef.current = null;
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

  return (
    <footer className="chat-composer-footer shrink-0 px-3 py-2.5 sm:px-4">
      {sofiaStoppedAll ? (
        <div className="mb-2 flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs chat-notice">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div>
            <p className="font-semibold">Sofia está pausada en toda la línea</p>
            <p className="mt-0.5 opacity-90">
              No responderá en ningún chat de este número. Usa{" "}
              <span className="font-semibold">Reanudar todos</span> en los
              controles de Sofia.
            </p>
          </div>
        </div>
      ) : sofiaChatPaused ? (
        <div className="mb-2 flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs chat-notice">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <div>
            <p className="font-semibold">Sofia está pausada en este chat</p>
            <p className="mt-0.5 opacity-90">
              Usa <span className="font-semibold">Reanudar chat</span> en los
              controles de Sofia para activarla aquí.
            </p>
          </div>
        </div>
      ) : null}
      {!canText ? (
        <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs chat-notice">
          <p className="font-semibold">Ventana de 24h cerrada</p>
          <p className="mt-1 opacity-90">
            WhatsApp Business no permite enviar mensajes libres desde Sofia Chat
            hasta que el contacto escriba de nuevo. Puedes iniciar la
            conversación tú mismo abriendo el chat en WhatsApp.
          </p>
          {whatsappUrl ? (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[#25D366] px-3 py-1.5 text-xs font-semibold text-[#0b141a] hover:brightness-95"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Abrir en WhatsApp
            </a>
          ) : (
            <p className="mt-2 opacity-80">{windowHint}</p>
          )}
        </div>
      ) : null}
      {replyPreview !== null ? (
        <div className="mb-2 flex items-start gap-2 rounded-xl bg-[var(--surface-3)] px-3 py-2">
          <div className="min-w-0 flex-1 border-l-2 border-[var(--accent)] pl-2">
            <p className="text-[11px] font-semibold text-[var(--accent)]">
              Respondiendo
            </p>
            <p className="truncate text-xs text-[var(--muted)]">{replyPreview}</p>
          </div>
          <button
            type="button"
            aria-label="Cancelar respuesta"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--surface)]"
            onClick={onCancelReply}
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
            <p className="text-sm font-semibold text-[var(--danger)]">
              Grabando nota de voz…
            </p>
            <p className="font-mono text-xs text-[var(--muted)]">
              {recordLabel} · toca el cuadrado para enviar
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <div className={`chat-composer min-w-0 flex-1 ${!canText || recording ? "opacity-60" : ""}`}>
          <EmojiPicker
            disabled={!canText || mediaSending || recording}
            onPick={insertEmoji}
          />
          <SofiaCommandsHelp
            pending={sofiaPending}
            onAction={onSofiaAction}
            sofiaStoppedAll={sofiaStoppedAll}
            chatPaused={sofiaChatPaused}
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
            onChange={(e) => updateText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!canText || mediaSending || recording}
          />
        </div>
        {hasText && !recording ? (
          <Button
            type="button"
            size="icon"
            className="chat-composer-send"
            onClick={send}
            disabled={!canText || mediaSending}
            aria-label="Enviar mensaje"
            title="Enviar (Enter)"
          >
            {mediaSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            className={`chat-composer-send ${recording ? "chat-composer-send--recording" : ""}`}
            disabled={!canText || mediaSending || preparingMic}
            aria-label={recording ? "Detener y enviar nota de voz" : "Nota de voz"}
            title={recording ? "Detener y enviar" : "Nota de voz (OGG)"}
            onClick={() => void toggleRecording()}
          >
            {preparingMic || mediaSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : recording ? (
              <Square className="h-4 w-4 fill-current" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
      {canText && !recording ? (
        <p className="chat-composer-hint mt-1.5 text-[10px] text-[var(--muted)]">
          Enter envía · Shift+Enter salto
        </p>
      ) : null}
    </footer>
  );
}
