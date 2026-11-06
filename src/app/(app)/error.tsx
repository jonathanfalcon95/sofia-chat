"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <AlertTriangle className="h-10 w-10 text-[var(--muted)]" aria-hidden />
      <h1 className="text-lg font-semibold text-[var(--ink)]">
        No se pudo cargar esta página
      </h1>
      <p className="max-w-md text-sm text-[var(--muted)]">
        Puede ser un problema temporal. Inténtalo de nuevo en unos segundos.
      </p>
      <Button type="button" variant="secondary" onClick={() => retry()}>
        Reintentar
      </Button>
    </div>
  );
}
