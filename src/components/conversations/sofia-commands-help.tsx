"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleHelp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type SofiaControlAction =
  | "stop"
  | "start"
  | "stop-all"
  | "start-all"
  | "whitelist";

const ACTIONS: Array<{
  action: SofiaControlAction;
  label: string;
  description: string;
  tone: "pause" | "resume" | "whitelist" | "global";
  warning?: boolean;
}> = [
  {
    action: "stop",
    label: "Pausar chat",
    description: "Sofia deja de responder solo en esta conversación.",
    tone: "pause",
  },
  {
    action: "start",
    label: "Reanudar chat",
    description: "Vuelve a activar a Sofia en este chat.",
    tone: "resume",
  },
  {
    action: "whitelist",
    label: "Lista blanca",
    description: "Sofia no podrá interactuar con este número.",
    tone: "whitelist",
  },
  {
    action: "stop-all",
    label: "Pausar todos",
    description: "Sofia se detiene en toda la línea. Útil para mantenimiento.",
    tone: "global",
    warning: true,
  },
  {
    action: "start-all",
    label: "Reanudar todos",
    description: "Vuelve a activar a Sofia en toda la línea.",
    tone: "global",
  },
];

const WHATSAPP_COMMANDS = [
  { command: "/stopsofia", description: "Pausar este chat." },
  { command: "/startsofia", description: "Reanudar este chat." },
  { command: "/stopsofia_all", description: "Pausar toda la línea." },
  { command: "/startsofia_all", description: "Reanudar toda la línea." },
  { command: "/whitelist", description: "Agregar el número a la lista blanca." },
] as const;

export function SofiaCommandsHelp({
  pending = null,
  onAction,
  sofiaStoppedAll = false,
  chatPaused = false,
}: {
  pending?: SofiaControlAction | null;
  onAction: (action: SofiaControlAction) => void;
  sofiaStoppedAll?: boolean;
  chatPaused?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Controles de Sofia"
        title={
          sofiaStoppedAll
            ? "Sofia pausada en toda la línea"
            : chatPaused
              ? "Sofia pausada en este chat"
              : "Controles de Sofia"
        }
        className={`h-9 w-9 shrink-0 rounded-full border-0 hover:bg-[var(--surface-2)] ${
          sofiaStoppedAll || chatPaused
            ? "text-amber-600 hover:text-amber-700 dark:text-amber-400"
            : "text-[var(--muted)] hover:text-[var(--ink)]"
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        {sofiaStoppedAll || chatPaused ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <CircleHelp className="h-4 w-4" />
        )}
      </Button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(100vw-2rem,320px)] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg">
          <div className="mb-2 px-1.5 pt-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              Sofia
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">
              Estas acciones no envían un mensaje al chat.
            </p>
          </div>
          {sofiaStoppedAll ? (
            <div className="mb-2 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-900 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-semibold">Sofia pausada en toda la línea</p>
                <p className="mt-0.5 opacity-90">
                  Usa <span className="font-semibold">Reanudar todos</span> para
                  reactivarla.
                </p>
              </div>
            </div>
          ) : chatPaused ? (
            <div className="mb-2 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-900 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p>
                Sofia está pausada en este chat. Usa{" "}
                <span className="font-semibold">Reanudar chat</span>.
              </p>
            </div>
          ) : null}
          <div className="space-y-0.5">
            {ACTIONS.map((item) => {
              const busy = pending === item.action;
              return (
                <button
                  key={item.action}
                  type="button"
                  disabled={pending !== null}
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)] disabled:opacity-60 ${
                    item.warning ? "border border-amber-500/25 bg-amber-500/5" : ""
                  }`}
                  onClick={() => onAction(item.action)}
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      item.tone === "pause"
                        ? "bg-red-500"
                        : item.tone === "resume"
                          ? "bg-emerald-500"
                          : item.tone === "global"
                            ? "bg-amber-500"
                            : "bg-sky-500"
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold text-[var(--ink)]">
                        {item.label}
                      </span>
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin text-[var(--muted)]" />
                      ) : null}
                      {item.warning ? (
                        <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                          Advertencia
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-[11px] leading-snug text-[var(--muted)]">
                      {item.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="mt-2 w-full rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-[var(--muted)] hover:bg-[var(--surface-2)]"
            onClick={() => setShowCommands((v) => !v)}
          >
            {showCommands ? "Ocultar" : "Ver"} comandos de WhatsApp
          </button>
          {showCommands ? (
            <div className="mt-1 space-y-1 border-t border-[var(--line)] px-1.5 pt-2">
              <p className="text-[11px] leading-snug text-[var(--muted)]">
                Siguen funcionando si los escribes en el chat. Desde aquí solo
                son referencia.
              </p>
              {WHATSAPP_COMMANDS.map((item) => (
                <p key={item.command} className="text-[11px] leading-snug">
                  <code className="font-mono font-semibold text-[var(--ink)]">
                    {item.command}
                  </code>{" "}
                  <span className="text-[var(--muted)]">{item.description}</span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
