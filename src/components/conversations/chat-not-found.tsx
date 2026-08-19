import Link from "next/link";
import { MessageSquareOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ChatNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <MessageSquareOff
        className="h-10 w-10 text-[var(--muted)]"
        aria-hidden
      />
      <h1 className="text-lg font-semibold text-[var(--ink)]">
        Conversación no encontrada
      </h1>
      <p className="max-w-md text-sm text-[var(--muted)]">
        No hay un chat con ese número en esta empresa, o no tienes acceso.
      </p>
      <Button asChild variant="secondary">
        <Link href="/conversations">Volver a conversaciones</Link>
      </Button>
    </div>
  );
}
