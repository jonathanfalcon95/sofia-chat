"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Loader2,
  MapPin,
  Reply,
  SmilePlus,
  ExternalLink,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { WhatsAppText } from "@/components/conversations/whatsapp-text";
import { MessageComposer } from "@/components/conversations/message-composer";
import { MessageStatusIcon } from "@/components/conversations/message-status-icon";
import { MessageMedia } from "@/components/conversations/message-media";
import { RichMessage } from "@/components/conversations/rich-message";
import { parseRichContent } from "@/lib/ycloud/rich-content";
import {
  extractUrlFromBody,
  formatRevokedMessage,
  isSpecialNoticeType,
  sanitizeMessageBody,
} from "@/lib/ycloud/inbound-message-display";
import { groupMessagesByDay } from "@/lib/conversations/day-grouping";
import type { MessageRow } from "@/lib/conversations/types";
import type { SofiaControlAction } from "@/components/conversations/sofia-commands-help";

const REACTION_SET = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

/** Types whose header and buttons live in rich_content. */
const RICH_TYPES = new Set(["template", "interactive", "button"]);

function isMedia(type: string) {
  return ["image", "audio", "video", "document", "sticker"].includes(type);
}

function messageWamid(m: MessageRow) {
  if (m.wamid) return m.wamid;
  if (m.ycloud_message_id?.startsWith("wamid.")) return m.ycloud_message_id;
  return null;
}

function parseLocationLink(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  if (match) {
    return `https://www.google.com/maps/search/?api=1&query=${match[1]},${match[2]}`;
  }
  const clean = body.replace(/^[📍\s]+/, "").trim();
  if (clean && clean !== "Ubicación compartida" && clean !== "Ubicación") {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
  }
  return null;
}

function quotedPreview(m: MessageRow) {
  if (m.type === "image")
    return m.body?.trim() ? `📷 ${sanitizeMessageBody(m.body, m.type)}` : "📷 Imagen";
  if (m.type === "video")
    return m.body?.trim() ? `🎬 ${sanitizeMessageBody(m.body, m.type)}` : "🎬 Video";
  if (m.type === "audio") return "🎤 Nota de voz";
  if (m.type === "document")
    return `📄 ${m.media_filename || sanitizeMessageBody(m.body, m.type) || "Documento"}`;
  if (m.type === "sticker") return "Sticker";
  if (m.type === "location")
    return `📍 ${sanitizeMessageBody(m.body, m.type)}`;
  return sanitizeMessageBody(
    m.body || m.template_name || m.type || "Mensaje",
    m.type,
  ).slice(0, 120);
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
  contactPhone,
  onSendText,
  onSofiaAction,
  sofiaPending = null,
  onSendMedia,
  mediaSending,
  composerRef,
  onFirstPaint,
  replyTo,
  onReplyTo,
  onReact,
  sofiaStoppedAll = false,
  sofiaChatPaused = false,
}: {
  activeConversationId: string;
  messages: MessageRow[];
  loadingThread: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  canText: boolean;
  windowHint: string;
  contactPhone?: string | null;
  onSendText: (text: string) => boolean;
  onSofiaAction: (action: SofiaControlAction) => void;
  sofiaPending?: SofiaControlAction | null;
  onSendMedia: (file: File, caption?: string) => Promise<void>;
  mediaSending: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onFirstPaint?: (conversationId: string) => void;
  replyTo: MessageRow | null;
  onReplyTo: (message: MessageRow | null) => void;
  onReact: (message: MessageRow, emoji: string) => void;
  sofiaStoppedAll?: boolean;
  sofiaChatPaused?: boolean;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const firstPaintDoneForConversationRef = useRef<string | null>(null);
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null);
  const [reactPickerId, setReactPickerId] = useState<string | null>(null);
  const firstMessageId = messages[0]?.id;
  const lastMessageId = messages[messages.length - 1]?.id;
  const actionsOpen = menuMessageId !== null || reactPickerId !== null;

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

  // Touch has no hover or mouse-leave, so close open actions on any outside tap.
  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest("[data-msg-actions]")) return;
      setMenuMessageId(null);
      setReactPickerId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [actionsOpen]);

  function handleScroll() {
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
    if (el.scrollTop < 80 && hasMore && !loadingOlder) {
      onLoadOlder();
    }
  }

  const dayGroups = useMemo(() => groupMessagesByDay(messages), [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="chat-thread-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-[4%] py-3"
      >
        {loadingThread ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-12 w-2/3 rounded-lg" />
            <Skeleton className="ml-auto h-12 w-1/2 rounded-lg" />
            <Skeleton className="h-16 w-3/5 rounded-lg" />
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
            <div className="flex flex-col gap-3">
              {dayGroups.map((group) => (
                <div key={group.dayKey} className="relative flex flex-col">
                  <div className="pointer-events-none sticky top-1 z-10 mb-1 flex justify-center py-1">
                    <span className="pointer-events-auto select-none rounded-lg bg-[var(--surface-2)] px-3 py-1 text-[11px] font-medium text-[var(--muted)] shadow-xs">
                      {group.dayLabel}
                    </span>
                  </div>
                  {group.messages.map((m, index) => {
                    const media = isMedia(m.type);
                    const notice = isSpecialNoticeType(m.type, m.body);
                    const outbound = m.direction === "outbound";
                    const previous = group.messages[index - 1];
                    const startsRun =
                      !previous ||
                      previous.direction !== m.direction ||
                      isSpecialNoticeType(previous.type, previous.body);
                    const rich = RICH_TYPES.has(m.type)
                      ? parseRichContent(m.rich_content)
                      : null;
                    const interactiveUrl =
                      m.type === "interactive" ? extractUrlFromBody(m.body) : null;
                    const quoted = m.reply_to_wamid
                      ? byWamid.get(m.reply_to_wamid)
                      : null;
                    const reactions = Array.isArray(m.reactions) ? m.reactions : [];
                    const ourReaction = reactions.find((r) => r.direction === "outbound");
                    const showMenu = menuMessageId === m.id;
                    const showReact = reactPickerId === m.id;
                    const hasWamid = Boolean(messageWamid(m));
                    const opensUp = m.id === lastMessageId;
                    const popoverPosition = `${outbound ? "right-0" : "left-0"} ${
                      opensUp ? "bottom-full mb-1" : "top-full mt-1"
                    }`;

                    if (notice) {
                      return (
                        <div
                          key={m.id}
                          className="mx-auto my-1 max-w-[90%] rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-center text-xs text-[var(--muted)]"
                        >
                          {sanitizeMessageBody(m.body, m.type) || formatRevokedMessage()}
                          <div className="mt-1 text-[10px] opacity-70">
                            {new Date(m.created_at).toLocaleTimeString("es", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={m.id}
                        className={`group relative flex flex-col ${
                          outbound ? "items-end" : "items-start"
                        } ${startsRun ? "mt-2" : "mt-0.5"}`}
                        onMouseLeave={() => {
                          if (menuMessageId === m.id) setMenuMessageId(null);
                          if (reactPickerId === m.id) setReactPickerId(null);
                        }}
                      >
                        <div
                          className={`msg-bubble text-[14.2px] leading-[1.35] ${
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
                              : "px-2.5 py-1.5"
                          } ${outbound ? "msg-out" : "msg-in"} ${
                            startsRun && m.type !== "sticker" ? "msg-tail" : ""
                          }`}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenuMessageId(m.id);
                            setReactPickerId(null);
                          }}
                        >
                          {m.reply_to_wamid ? (
                            <div
                              className={`mb-1.5 rounded-md border-l-2 px-2 py-1 text-[12px] ${
                                outbound
                                  ? "border-white/50 bg-black/15 text-white/85"
                                  : "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--muted)]"
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
                          ) : rich ? (
                            <RichMessage rich={rich} outbound={outbound} />
                          ) : m.type === "contacts" ? (
                            <div className="space-y-1">
                              <p className="text-[11px] font-semibold uppercase tracking-wide opacity-70">
                                Contacto
                              </p>
                              <div className="wa-text break-words whitespace-pre-wrap">
                                <WhatsAppText text={sanitizeMessageBody(m.body, m.type)} />
                              </div>
                            </div>
                          ) : m.type === "interactive" ? (
                            <div className="space-y-2">
                              <div className="wa-text break-words whitespace-pre-wrap">
                                <WhatsAppText text={sanitizeMessageBody(m.body, m.type)} />
                              </div>
                              {interactiveUrl ? (
                                <a
                                  href={interactiveUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                                    outbound
                                      ? "border-white/40 text-white hover:bg-white/10"
                                      : "border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                                  }`}
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  Abrir enlace
                                </a>
                              ) : null}
                            </div>
                          ) : m.type === "location" ? (
                            <div className="space-y-2">
                              <div className="flex items-start gap-2">
                                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                                <div className="wa-text break-words whitespace-pre-wrap">
                                  <WhatsAppText text={sanitizeMessageBody(m.body, m.type)} />
                                </div>
                              </div>
                              {(() => {
                                const mapUrl = parseLocationLink(m.body);
                                if (!mapUrl) return null;
                                return (
                                  <a
                                    href={mapUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                                      outbound
                                        ? "border-white/40 text-white hover:bg-white/10"
                                        : "border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                                    }`}
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                    Ver en Google Maps
                                  </a>
                                );
                              })()}
                            </div>
                          ) : (
                            <div className="wa-text break-words whitespace-pre-wrap">
                              <WhatsAppText text={sanitizeMessageBody(m.body, m.type)} />
                            </div>
                          )}
                          <div
                            className={`mt-0.5 flex items-center justify-end gap-1 pl-3 text-[10.5px] leading-none ${
                              outbound && m.type !== "sticker"
                                ? "text-white/70"
                                : "text-[var(--muted)]"
                            }`}
                          >
                            {m.template_name ? (
                              <span className="min-w-0 truncate">{m.template_name} ·</span>
                            ) : null}
                            <span className="shrink-0">
                              {new Date(m.created_at).toLocaleTimeString("es", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            {outbound ? (
                              <MessageStatusIcon status={m.status} />
                            ) : null}
                          </div>

                          <div data-msg-actions>
                            <button
                              type="button"
                              aria-label="Acciones del mensaje"
                              aria-expanded={showMenu}
                              className={`msg-actions-trigger ${
                                outbound ? "msg-actions-trigger--out" : "msg-actions-trigger--in"
                              } ${showMenu || showReact ? "msg-actions-trigger--open" : ""}`}
                              onClick={() => {
                                setReactPickerId(null);
                                setMenuMessageId((id) => (id === m.id ? null : m.id));
                              }}
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>

                            {showMenu ? (
                              <div
                                className={`absolute z-20 flex w-36 flex-col overflow-hidden rounded-lg bg-[var(--surface-3)] py-1 text-[13px] text-[var(--ink)] shadow-lg ${popoverPosition}`}
                              >
                                <button
                                  type="button"
                                  disabled={!canText || !hasWamid}
                                  title={
                                    hasWamid
                                      ? "Responder"
                                      : "Espera a que WhatsApp asigne wamid"
                                  }
                                  className="flex min-h-10 items-center gap-2 px-3 text-left hover:bg-[var(--accent-soft)] disabled:opacity-40"
                                  onClick={() => {
                                    if (!hasWamid) return;
                                    onReplyTo(m);
                                    setMenuMessageId(null);
                                    composerRef.current?.focus();
                                  }}
                                >
                                  <Reply className="h-3.5 w-3.5" />
                                  Responder
                                </button>
                                <button
                                  type="button"
                                  disabled={!canText || !hasWamid}
                                  title={
                                    hasWamid
                                      ? "Reaccionar"
                                      : "Espera a que WhatsApp asigne wamid"
                                  }
                                  className="flex min-h-10 items-center gap-2 px-3 text-left hover:bg-[var(--accent-soft)] disabled:opacity-40"
                                  onClick={() => {
                                    setReactPickerId(m.id);
                                    setMenuMessageId(null);
                                  }}
                                >
                                  <SmilePlus className="h-3.5 w-3.5" />
                                  Reaccionar
                                </button>
                              </div>
                            ) : null}

                            {showReact ? (
                              <div
                                className={`absolute z-20 flex gap-0.5 rounded-full bg-[var(--surface-3)] p-1 shadow-lg ${popoverPosition}`}
                              >
                                {REACTION_SET.map((emoji) => (
                                  <button
                                    key={emoji}
                                    type="button"
                                    className="h-9 w-9 rounded-full text-base hover:bg-[var(--accent-soft)]"
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
                        </div>

                        {reactions.length > 0 ? (
                          <div className="relative z-[1] -mt-1 flex flex-wrap gap-1 px-2">
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
                                    ? "border-[var(--accent)] bg-[var(--surface-3)]"
                                    : "border-[var(--line)] bg-[var(--surface-2)]"
                                }`}
                              >
                                {emoji}
                                {count > 1 ? ` ${count}` : ""}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              <div ref={bottomRef} aria-hidden className="h-px w-full" />
            </div>
          </>
        )}
      </div>

      <MessageComposer
        key={activeConversationId}
        conversationId={activeConversationId}
        canText={canText}
        windowHint={windowHint}
        contactPhone={contactPhone}
        onSendText={onSendText}
        onSendMedia={onSendMedia}
        mediaSending={mediaSending}
        onSofiaAction={onSofiaAction}
        sofiaPending={sofiaPending}
        sofiaStoppedAll={sofiaStoppedAll}
        sofiaChatPaused={sofiaChatPaused}
        composerRef={composerRef}
        replyPreview={replyTo ? quotedPreview(replyTo) : null}
        onCancelReply={() => onReplyTo(null)}
      />
    </div>
  );
}
