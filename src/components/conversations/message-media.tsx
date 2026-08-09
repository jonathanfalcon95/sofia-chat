"use client";

import { useState } from "react";
import { FileText, Mic, X } from "lucide-react";
import type { MessageRow } from "@/lib/conversations/types";
import { takeMediaPreview } from "@/lib/media-preview-cache";

function mediaSrc(m: MessageRow) {
  if (m.localPreviewUrl) return m.localPreviewUrl;
  const cached = takeMediaPreview(m.id);
  if (cached) return cached;
  if (m.media_url) return `/api/media/${m.id}`;
  return null;
}

function MediaFallback({
  label,
  outbound,
}: {
  label: string;
  outbound?: boolean;
}) {
  return (
    <div className={`px-2 py-1 text-sm opacity-90 ${outbound ? "text-white/90" : ""}`}>
      {label}
    </div>
  );
}

function isPlainMediaLabel(body: string | null | undefined, type: string) {
  if (!body) return true;
  const labels = ["Imagen", "Nota de voz", "Video", "Sticker", "Documento", `[${type}]`];
  return labels.includes(body);
}

export function MessageMedia({
  message: m,
  onContentReady,
}: {
  message: MessageRow;
  onContentReady?: () => void;
}) {
  const [lightbox, setLightbox] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = mediaSrc(m);
  const type = m.type;
  const outbound = m.direction === "outbound";

  if (type === "image" || type === "sticker") {
    if (!src || failed) {
      return (
        <MediaFallback
          label={m.body || (type === "sticker" ? "Sticker" : "Imagen")}
          outbound={outbound}
        />
      );
    }
    return (
      <>
        <button
          type="button"
          className="msg-media-frame"
          onClick={() => setLightbox(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={m.body || "Imagen"}
            loading="lazy"
            decoding="async"
            onLoad={() => onContentReady?.()}
            onError={() => {
              setFailed(true);
              onContentReady?.();
            }}
          />
        </button>
        {type === "image" && !isPlainMediaLabel(m.body, type) ? (
          <div className="mt-1.5 px-1.5 text-sm leading-snug">{m.body}</div>
        ) : null}
        {lightbox ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setLightbox(false)}
            role="dialog"
            aria-modal
          >
            <button
              type="button"
              className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white"
              onClick={() => setLightbox(false)}
              aria-label="Cerrar"
            >
              <X className="h-5 w-5" />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={m.body || "Imagen"}
              className="max-h-[90vh] max-w-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ) : null}
      </>
    );
  }

  if (type === "audio") {
    if (!src || failed) {
      return (
        <div className="flex items-center gap-2 px-1 text-sm">
          <Mic className="h-4 w-4 shrink-0" />
          {m.body || "Nota de voz"}
        </div>
      );
    }
    return (
      <div className="w-full min-w-0">
        <audio
          controls
          preload="metadata"
          className="block h-10 w-full"
          src={src}
          onLoadedMetadata={() => onContentReady?.()}
          onError={() => {
            setFailed(true);
            onContentReady?.();
          }}
        />
        {!isPlainMediaLabel(m.body, type) ? (
          <div className="mt-1 text-xs opacity-80">{m.body}</div>
        ) : null}
      </div>
    );
  }

  if (type === "video") {
    if (!src || failed) {
      return <MediaFallback label={m.body || "Video"} outbound={outbound} />;
    }
    return (
      <div className="msg-media-frame">
        <video
          controls
          preload="metadata"
          src={src}
          onLoadedMetadata={() => onContentReady?.()}
          onError={() => {
            setFailed(true);
            onContentReady?.();
          }}
        />
      </div>
    );
  }

  if (type === "document") {
    const href = !failed ? src || undefined : undefined;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-sm ${
          outbound ? "border-white/30 text-white" : "border-[var(--line)]"
        } ${href ? "hover:underline" : "pointer-events-none opacity-70"}`}
        onClick={(e) => {
          if (!href) e.preventDefault();
        }}
      >
        <FileText className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">
          {m.media_filename || m.body || "Documento"}
        </span>
      </a>
    );
  }

  return <MediaFallback label={m.body || type || "Adjunto"} outbound={outbound} />;
}
