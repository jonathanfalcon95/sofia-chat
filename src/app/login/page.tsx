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
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#070b14] px-4 py-12 text-[#e8eef9]">
      {/* Background ambient lighting */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[700px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(0,150,255,0.18)_0%,rgba(0,82,204,0.08)_50%,transparent_70%)] blur-2xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 right-10 h-[400px] w-[500px] bg-[radial-gradient(ellipse_at_center,rgba(0,82,204,0.15)_0%,transparent_70%)] blur-2xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.15) 1px, transparent 1px)",
          backgroundSize: "28px 24px",
        }}
      />

      {/* Login Card */}
      <form
        onSubmit={onSubmit}
        aria-busy={loading}
        className="relative z-10 w-full max-w-md space-y-6 overflow-hidden rounded-2xl border border-[#1e293b] bg-[#0b1220]/90 p-8 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.7)] shadow-black/60 backdrop-blur-xl sm:p-10"
      >
        {/* Loading Overlay */}
        {loading ? (
          <div
            className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl bg-[#0b1220]/95 backdrop-blur-md text-[#e8eef9]"
            role="status"
            aria-live="polite"
          >
            <div className="relative flex items-center justify-center">
              <div
                className="absolute h-12 w-12 rounded-full bg-[#0096ff]/20 animate-ping"
                aria-hidden
              />
              <Loader2
                className="h-10 w-10 animate-spin text-[#0096ff]"
                aria-hidden
              />
            </div>
            <p className="text-base font-semibold tracking-wide text-[#e8eef9]">
              Entrando…
            </p>
            <p className="text-xs text-[#93a4c3]">Preparando tu inbox</p>
          </div>
        ) : null}

        {/* Brand Header & Logo */}
        <div className="flex flex-col items-center space-y-3 text-center">
          <div className="flex w-full items-center justify-center py-2">
            <Image
              src="/sofia-logo.webp"
              alt="Sofia Chat"
              width={320}
              height={120}
              className="h-auto w-full max-w-[260px] object-contain mix-blend-screen drop-shadow-[0_0_25px_rgba(0,150,255,0.3)] sm:max-w-[290px]"
              priority
            />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-[#e8eef9]">
              Sofia Chat
            </h1>
            <p className="text-xs text-[#93a4c3]">
              Inbox WhatsApp multi-empresa
            </p>
          </div>
        </div>

        {/* Inputs */}
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="email"
              className="text-xs font-semibold uppercase tracking-wider text-[#93a4c3]"
            >
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="tu@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              className="h-11 rounded-xl border-[#1e293b] bg-[#05070d]/80 text-sm text-[#e8eef9] placeholder:text-[#5b6b86] focus-visible:border-[#0096ff] focus-visible:ring-2 focus-visible:ring-[#0096ff]/30"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="password"
              className="text-xs font-semibold uppercase tracking-wider text-[#93a4c3]"
            >
              Contraseña
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 rounded-xl border-[#1e293b] bg-[#05070d]/80 pr-10 text-sm text-[#e8eef9] placeholder:text-[#5b6b86] focus-visible:border-[#0096ff] focus-visible:ring-2 focus-visible:ring-[#0096ff]/30"
                disabled={loading}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={loading}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-lg p-1.5 text-[#93a4c3] transition hover:bg-[#121a2b] hover:text-[#e8eef9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0096ff]/40 disabled:pointer-events-none disabled:opacity-50"
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

        {/* Submit Button */}
        <Button
          type="submit"
          className="h-11 w-full rounded-xl bg-gradient-to-r from-[#0096ff] to-[#0052cc] text-sm font-semibold text-white shadow-lg shadow-[#0096ff]/20 transition hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
          loading={loading}
        >
          {loading ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </main>
  );
}
