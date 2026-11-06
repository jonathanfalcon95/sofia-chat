"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Only platform admins can use it; anyone else gets the server's refusal. */
export function ResetPassword({ userId }: { userId: string }) {
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(
          res.status === 403
            ? "Solo un super admin puede restablecer contraseñas"
            : (body?.error ?? "No se pudo restablecer la contraseña"),
        );
        return;
      }
      setPassword("");
      toast.success("Contraseña restablecida. Sus sesiones abiertas se cerraron.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="rounded-lg border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Restablecer contraseña</summary>
      <div className="mt-3 space-y-2">
        <Label htmlFor="reset-password">Nueva contraseña</Label>
        <Input
          id="reset-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={saving || password.length === 0}
          onClick={() => void save()}
        >
          Guardar contraseña
        </Button>
      </div>
    </details>
  );
}
