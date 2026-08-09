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

export function MessageMedia({ message: m }: { message: MessageRow }) {
  const [lightbox, setLightbox] = useState(false);
  const src = mediaSrc(m);
  const type = m.type;

  if (type === "image" || type === "sticker") {
    if (!src) {
      return (
        <div className="text-xs opacity-80">{m.body || "Imagen"}</div>
      );
    }
    return (
      <>
        <button
          type="button"
          className="block overflow-hidden rounded-lg"
          onClick={() => setLightbox(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={m.body || "Imagen"}
            className={`max-h-64 max-w-full object-contain ${
              type === "sticker" ? "max-h-40" : ""
            }`}
          />
        </button>
        {m.body && type === "image" ? (
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
    if (!src) {
      return (
        <div className="flex items-center gap-2 text-sm">
          <Mic className="h-4 w-4" />
          {m.body || "Nota de voz"}
        </div>
      );
    }
    return (
      <div className="min-w-[200px]">
        <audio controls preload="metadata" className="w-full max-w-[260px]">
          <source src={src} type={m.media_mime || undefined} />
        </audio>
        {m.body && m.body !== "Nota de voz" ? (
          <div className="mt-1 text-xs opacity-80">{m.body}</div>
        ) : null}
      </div>
    );
  }

  if (type === "video") {
    if (!src) {
      return <div className="text-xs opacity-80">{m.body || "Video"}</div>;
    }
    return (
      <video
        controls
        preload="metadata"
        className="max-h-64 max-w-full rounded-lg"
      >
        <source src={src} type={m.media_mime || undefined} />
      </video>
    );
  }

  if (type === "document") {
    const href = src || undefined;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
          m.direction === "outbound"
            ? "border-white/30 text-white"
            : "border-[var(--line)]"
        } ${href ? "hover:underline" : "pointer-events-none opacity-70"}`}
      >
        <FileText className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {m.media_filename || m.body || "Documento"}
        </span>
      </a>
    );
  }

  return null;
}
