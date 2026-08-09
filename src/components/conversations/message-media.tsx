"use client";

import { useState } from "react";
import { FileText, Mic, X } from "lucide-react";
import type { MessageRow } from "@/lib/conversations/types";

function mediaSrc(m: MessageRow) {
  if (m.localPreviewUrl) return m.localPreviewUrl;
  // Only proxy when we have a durable YCloud download link (inbound).
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
    <div
      className={`text-sm opacity-90 ${outbound ? "text-white/90" : ""}`}
    >
      {label}
    </div>
  );
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
          className="block max-w-full overflow-hidden rounded-lg"
          onClick={() => setLightbox(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={m.body || "Imagen"}
            className={`max-h-64 max-w-full object-contain ${
              type === "sticker" ? "max-h-32" : ""
            }`}
            style={{ maxHeight: type === "sticker" ? 128 : 256 }}
            loading="lazy"
            decoding="async"
            onLoad={() => onContentReady?.()}
            onError={() => {
              setFailed(true);
              onContentReady?.();
            }}
          />
        </button>
        {m.body && type === "image" && m.body !== "Imagen" && m.body !== "[image]" ? (
          <div className="mt-1.5 text-sm">{m.body}</div>
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
        <div className="flex items-center gap-2 text-sm">
          <Mic className="h-4 w-4" />
          {m.body || "Nota de voz"}
        </div>
      );
    }
    return (
      <div className="min-w-[200px]">
        <audio
          controls
          preload="metadata"
          className="w-full max-w-[260px]"
          onLoadedMetadata={() => onContentReady?.()}
          onError={() => {
            setFailed(true);
            onContentReady?.();
          }}
        >
          <source src={src} type={m.media_mime || undefined} />
        </audio>
        {m.body && m.body !== "Nota de voz" ? (
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
      <video
        controls
        preload="metadata"
        className="max-h-64 max-w-full rounded-lg"
        onLoadedMetadata={() => onContentReady?.()}
        onError={() => {
          setFailed(true);
          onContentReady?.();
        }}
      >
        <source src={src} type={m.media_mime || undefined} />
      </video>
    );
  }

  if (type === "document") {
    const href = !failed ? src || undefined : undefined;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
          outbound
            ? "border-white/30 text-white"
            : "border-[var(--line)]"
        } ${href ? "hover:underline" : "pointer-events-none opacity-70"}`}
        onClick={(e) => {
          if (!href) e.preventDefault();
        }}
      >
        <FileText className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {m.media_filename || m.body || "Documento"}
        </span>
      </a>
    );
  }

  return <MediaFallback label={m.body || type || "Adjunto"} outbound={outbound} />;
}
