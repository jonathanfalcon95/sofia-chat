"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
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

    setLoading(false);
    toast.success("Bienvenido a Sofia Chat");
    router.replace(
      firstChat?.id ? `/conversations/${firstChat.id}` : "/conversations",
    );
    router.refresh();
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(0,150,255,0.18),_transparent_55%),radial-gradient(ellipse_at_bottom_right,_rgba(0,82,204,0.12),_transparent_50%),var(--bg)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(0,82,204,0.12) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />

      <form
        onSubmit={onSubmit}
        className="relative w-full max-w-md space-y-7 rounded-2xl border border-[var(--line)] bg-[var(--surface)]/95 p-8 shadow-[var(--shadow)] backdrop-blur-sm sm:p-10"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <Image
            src="/sofia-logo.webp"
            alt="sofIA"
            width={112}
            height={112}
            className="h-28 w-28 object-contain"
            priority
          />
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
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-[var(--muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
          Entrar
        </Button>
      </form>
    </main>
  );
}
