"use client";

import {
  Check,
  CheckCheck,
  Clock,
  X,
} from "lucide-react";

export function MessageStatusIcon({ status }: { status: string | null | undefined }) {
  const s = (status || "").toLowerCase();
  if (s === "pending") {
    return <Clock className="h-3 w-3 opacity-80" aria-label="Enviando" />;
  }
  if (s === "failed" || s === "error") {
    return <X className="h-3 w-3 text-red-300" aria-label="Falló" />;
  }
  if (s === "read") {
    return (
      <CheckCheck className="h-3.5 w-3.5 text-sky-200" aria-label="Leído" />
    );
  }
  if (s === "delivered") {
    return (
      <CheckCheck className="h-3.5 w-3.5 opacity-80" aria-label="Entregado" />
    );
  }
  return <Check className="h-3 w-3 opacity-80" aria-label="Enviado" />;
}
