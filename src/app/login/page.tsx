"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@chatbase.local");
  const [password, setPassword] = useState("Admin123!");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (authError) {
      toast.error(authError.message);
      return;
    }
    toast.success("Bienvenido a Sofia Chat");
    router.push("/conversations");
    router.refresh();
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-7 shadow-[var(--shadow)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--line)] pb-5">
          <Image
            src="/sofia-logo.webp"
            alt="sofIA"
            width={52}
            height={52}
            className="h-12 w-12 object-contain"
            priority
          />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Sofia Chat</h1>
            <p className="text-sm text-[var(--muted)]">
              Inbox WhatsApp multi-empresa
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Contraseña</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" loading={loading}>
          Entrar
        </Button>
      </form>
    </main>
  );
}
