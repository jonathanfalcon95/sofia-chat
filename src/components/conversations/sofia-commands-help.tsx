"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";

const COMMAND_GROUPS = [
  {
    title: "Pausar Sofia",
    tone: "pause" as const,
    items: [
      {
        command: "/stopsofia",
        description: "Sofia se detiene solo en este chat.",
      },
    ],
  },
  {
    title: "Reanudar Sofia",
    tone: "resume" as const,
    items: [
      {
        command: "/startsofia",
        description: "Vuelve a activar a Sofia en este chat específico.",
      },
    ],
  },
  {
    title: "Lista blanca",
    tone: "whitelist" as const,
    items: [
      {
        command: "/whitelist",
        description:
          "Agrega el número actual a la lista blanca. Sofia no podrá interactuar con este número.",
      },
    ],
  },
  {
    title: "Global (todos los chats)",
    tone: "global" as const,
    items: [
      {
        command: "/stopsofia_all",
        description:
          "Sofia se detiene globalmente (no responderá en ningún chat). Útil para mantenimiento o emergencias.",
        warning: true,
      },
      {
        command: "/startsofia_all",
        description: "Vuelve a activar a Sofia globalmente en todos los chats.",
      },
    ],
  },
] as const;

export function SofiaCommandsHelp({
  disabled,
  onSelect,
  sofiaStoppedAll = false,
}: {
  disabled?: boolean;
  onSelect: (command: string) => void;
  sofiaStoppedAll?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
        disabled={disabled}
        aria-label="Ayuda de comandos Sofia"
        title={
          sofiaStoppedAll
            ? "Sofia pausada globalmente — ver comandos"
            : "Comandos Sofia"
        }
        className={`h-9 w-9 shrink-0 rounded-full border-0 hover:bg-[var(--surface-2)] ${
          sofiaStoppedAll
            ? "text-amber-600 hover:text-amber-700 dark:text-amber-400"
            : "text-[var(--muted)] hover:text-[var(--ink)]"
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        {sofiaStoppedAll ? (
          <AlertTriangle className="h-4 w-4" />
        ) : (
          <CircleHelp className="h-4 w-4" />
        )}
      </Button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-[min(100vw-2rem,320px)] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg">
          <div className="mb-2 px-1.5 pt-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
              Comandos Sofia
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">
              Toca un comando para enviarlo como mensaje en este chat.
            </p>
          </div>
          {sofiaStoppedAll ? (
            <div className="mb-2 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-900 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-semibold">Sofia pausada globalmente</p>
                <p className="mt-0.5 opacity-90">
                  No responderá en ningún chat. Envía{" "}
                  <code className="font-mono font-semibold">/startsofia_all</code>{" "}
                  para reactivarla.
                </p>
              </div>
            </div>
          ) : null}
          <div className="max-h-[280px] space-y-2 overflow-y-auto">
            {COMMAND_GROUPS.map((group) => (
              <div key={group.title}>
                <div className="mb-1 flex items-center gap-1.5 px-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      group.tone === "pause"
                        ? "bg-red-500"
                        : group.tone === "resume"
                          ? "bg-emerald-500"
                          : group.tone === "global"
                            ? "bg-amber-500"
                            : "bg-sky-500"
                    }`}
                    aria-hidden
                  />
                  <span className="text-[11px] font-semibold text-[var(--ink)]">
                    {group.title}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const isWarning = "warning" in item && item.warning;
                    return (
                      <button
                        key={item.command}
                        type="button"
                        className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)] ${
                          isWarning
                            ? "border border-amber-500/25 bg-amber-500/5"
                            : ""
                        }`}
                        onClick={() => {
                          onSelect(item.command);
                          setOpen(false);
                        }}
                      >
                        <span className="flex items-center gap-1.5">
                          <code className="font-mono text-[12px] font-semibold text-[var(--ink)]">
                            {item.command}
                          </code>
                          {isWarning ? (
                            <span className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                              Advertencia
                            </span>
                          ) : null}
                        </span>
                        <span className="text-[11px] leading-snug text-[var(--muted)]">
                          {item.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
