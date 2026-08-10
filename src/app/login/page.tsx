"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (authError) {
      setLoading(false);
      toast.error(authError.message);
      return;
    }

    // Land on a deep-linked chat so SSR can paint the thread immediately
    // (avoids /conversations → /conversations/[id] skeleton flicker).
    const { data: firstChat } = await supabase
      .from("conversations")
      .select("id")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    toast.success("Bienvenido a Sofia Chat");
    // Keep loader visible until navigation completes.
    router.replace(
      firstChat?.id ? `/conversations/${firstChat.id}` : "/conversations",
    );
    router.refresh();
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(145deg, #0096ff 0%, #0052cc 48%, #0b1220 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-16 h-72 w-72 rounded-full bg-white/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 bottom-0 h-80 w-80 rounded-full bg-[#0096ff]/35 blur-3xl"
      />

      <form
        onSubmit={onSubmit}
        aria-busy={loading}
        className="relative w-full max-w-md space-y-7 overflow-hidden rounded-2xl border border-white/40 bg-white p-8 shadow-[0_20px_60px_rgba(11,18,32,0.28)] sm:p-10"
      >
        {loading ? (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/90 backdrop-blur-[2px]"
            role="status"
            aria-live="polite"
          >
            <Loader2
              className="h-10 w-10 animate-spin text-[var(--accent)]"
              aria-hidden
            />
            <p className="text-sm font-semibold text-[var(--ink)]">
              Entrando…
            </p>
            <p className="text-xs text-[var(--muted)]">Preparando tu inbox</p>
          </div>
        ) : null}

        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex w-full justify-center rounded-xl bg-[#0b1220] px-4 py-5 sm:px-6 sm:py-6">
            <Image
              src="/sofia-logo.webp"
              alt="sofIA"
              width={420}
              height={160}
              className="h-auto w-full max-w-[320px] object-contain sm:max-w-[360px]"
              priority
            />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-3xl font-bold tracking-tight text-[var(--ink)]">
              Sofia Chat
            </h1>
            <p className="text-sm text-[var(--muted)]">
              Inbox WhatsApp multi-empresa
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="tu@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Contraseña</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
                disabled={loading}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={loading}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-[var(--muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-50"
                aria-label={
                  showPassword ? "Ocultar contraseña" : "Mostrar contraseña"
                }
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden />
                )}
              </button>
            </div>
          </div>
        </div>

        <Button type="submit" className="w-full" size="lg" loading={loading}>
          {loading ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </main>
  );
}
