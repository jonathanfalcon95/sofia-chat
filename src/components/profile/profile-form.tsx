"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changeMyPassword, updateMyProfile } from "@/app/actions/profile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type MembershipInfo = {
  companyName: string;
  roleNames: string[];
  inboxNames: string[];
};

export function ProfileForm({
  email,
  fullName,
  memberships,
  showAssignedCompanies,
}: {
  email: string;
  fullName: string | null;
  memberships: MembershipInfo[];
  showAssignedCompanies: boolean;
}) {
  const [name, setName] = useState(fullName ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingProfile, startProfile] = useTransition();
  const [savingPassword, startPassword] = useTransition();

  function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    startProfile(async () => {
      try {
        await updateMyProfile(name);
        toast.success("Perfil actualizado");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al guardar");
      }
    });
  }

  function savePassword(e: React.FormEvent) {
    e.preventDefault();
    startPassword(async () => {
      try {
        await changeMyPassword({
          currentPassword,
          newPassword,
          confirmPassword,
        });
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        toast.success("Contraseña actualizada");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al cambiar");
      }
    });
  }

  return (
    <div className="mx-auto grid max-w-xl gap-6">
      {showAssignedCompanies && memberships.length > 0 ? (
        <section className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
          <div>
            <h2 className="text-base font-bold">Empresas asignadas</h2>
            <p className="text-sm text-[var(--muted)]">
              Roles e inboxes a los que tienes acceso
            </p>
          </div>
          {memberships.map((m) => (
            <div
              key={m.companyName}
              className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3"
            >
              <div className="font-semibold">{m.companyName}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                Rol: {m.roleNames.join(", ") || "—"}
              </div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                Inboxes: {m.inboxNames.join(", ") || "Ninguno"}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <form
        onSubmit={saveProfile}
        className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
      >
        <div>
          <h2 className="text-base font-bold">Datos del perfil</h2>
          <p className="text-sm text-[var(--muted)]">
            Nombre visible en la aplicación
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={email} disabled readOnly />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fullName">Nombre completo</Label>
          <Input
            id="fullName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <Button type="submit" loading={savingProfile}>
          Guardar perfil
        </Button>
      </form>

      <form
        onSubmit={savePassword}
        className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5"
      >
        <div>
          <h2 className="text-base font-bold">Cambiar contraseña</h2>
          <p className="text-sm text-[var(--muted)]">
            Mínimo 8 caracteres. Necesitas la contraseña actual.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="currentPassword">Contraseña actual</Label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newPassword">Nueva contraseña</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirmar nueva contraseña</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <Button type="submit" variant="secondary" loading={savingPassword}>
          Actualizar contraseña
        </Button>
      </form>
    </div>
  );
}
