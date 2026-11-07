"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  List,
  Phone,
  Reply,
} from "lucide-react";
import { WhatsAppText } from "@/components/conversations/whatsapp-text";
import type { RichButton, RichContent } from "@/lib/ycloud/rich-content";

const MEDIA_HEADER_LABELS: Record<string, string> = {
  image: "📎 Imagen",
  video: "📎 Video",
  document: "📎 Documento",
  location: "📍 Ubicación",
};

const REPLY_LABELS: Partial<Record<RichContent["kind"], string>> = {
  button_reply: "Respuesta de botón",
  list_reply: "Respuesta de lista",
  form_reply: "Respuesta de formulario",
};

function ButtonIcon({ kind }: { kind: RichButton["kind"] }) {
  const className = "h-3.5 w-3.5 shrink-0";
  switch (kind) {
    case "url":
      return <ExternalLink className={className} />;
    case "phone":
      return <Phone className={className} />;
    case "copy_code":
      return <Copy className={className} />;
    case "flow":
      return <FileText className={className} />;
    default:
      return <Reply className={className} />;
  }
}

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

function RichButtonRow({ button, outbound }: { button: RichButton; outbound: boolean }) {
  const [copied, setCopied] = useState(false);
  const base = `flex w-full items-center justify-center gap-1.5 border-t px-2 py-1.5 text-[13px] font-medium ${
    outbound ? "border-white/20" : "border-[var(--line)]"
  }`;
  const active = outbound
    ? "text-white hover:bg-white/10"
    : "text-[var(--accent)] hover:bg-[var(--accent-soft)]";
  const inert = outbound
    ? "cursor-default text-white/80"
    : "cursor-default text-[var(--accent)] opacity-80";
  const content = (
    <>
      {copied ? <Check className="h-3.5 w-3.5 shrink-0" /> : <ButtonIcon kind={button.kind} />}
      <span className="min-w-0 truncate">{copied ? "Copiado" : button.text}</span>
    </>
  );

  if (button.kind === "url" && button.url) {
    return (
      <a href={button.url} target="_blank" rel="noopener noreferrer" className={`${base} ${active}`} title={button.url}>
        {content}
      </a>
    );
  }
  if (button.kind === "phone" && button.phone) {
    return (
      <a href={telHref(button.phone)} className={`${base} ${active}`} title={button.phone}>
        {content}
      </a>
    );
  }
  if (button.kind === "copy_code" && button.code) {
    const code = button.code;
    return (
      <button
        type="button"
        className={`${base} ${active}`}
        title={code}
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {content}
      </button>
    );
  }
  // What the customer can tap on their phone; nothing to do from the inbox.
  return (
    <div className={`${base} ${inert}`} aria-disabled="true">
      {content}
    </div>
  );
}

function RichList({ list, outbound }: { list: NonNullable<RichContent["list"]>; outbound: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`-mx-2.5 border-t ${outbound ? "border-white/20" : "border-[var(--line)]"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center justify-center gap-1.5 px-2 py-1.5 text-[13px] font-medium ${
          outbound ? "text-white hover:bg-white/10" : "text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        }`}
      >
        <List className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{list.button}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="space-y-2 px-2.5 pb-2 text-[12.5px]">
          {list.sections.map((section, s) => (
            <div key={s}>
              {section.title ? (
                <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-70">
                  {section.title}
                </p>
              ) : null}
              <ul className="space-y-1">
                {section.rows.map((row, r) => (
                  <li key={r}>
                    <span className="font-medium">{row.title}</span>
                    {row.description ? (
                      <span className="block text-[11.5px] opacity-70">{row.description}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A template or interactive message as the customer saw it, with its buttons. */
export function RichMessage({ rich, outbound }: { rich: RichContent; outbound: boolean }) {
  const replyLabel = REPLY_LABELS[rich.kind];
  return (
    <div className="space-y-1">
      {replyLabel ? (
        <p className="flex items-center gap-1 text-[11px] font-medium opacity-70">
          <Reply className="h-3 w-3" />
          {replyLabel}
        </p>
      ) : null}
      {rich.header ? (
        rich.header.type === "text" ? (
          <p className="wa-text font-semibold break-words">
            <WhatsAppText text={rich.header.text} />
          </p>
        ) : (
          <p className="text-[12px] opacity-75">{MEDIA_HEADER_LABELS[rich.header.type]}</p>
        )
      ) : null}
      {rich.body ? (
        <div className="wa-text break-words whitespace-pre-wrap">
          <WhatsAppText text={rich.body} />
        </div>
      ) : null}
      {rich.footer ? (
        <p className="text-[12px] break-words opacity-70">{rich.footer}</p>
      ) : null}
      {rich.buttons?.length ? (
        <div className="-mx-2.5 mt-1.5">
          {rich.buttons.map((button, i) => (
            <RichButtonRow key={i} button={button} outbound={outbound} />
          ))}
        </div>
      ) : null}
      {rich.list ? <RichList list={rich.list} outbound={outbound} /> : null}
    </div>
  );
}
