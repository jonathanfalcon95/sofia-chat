"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { updateMembership } from "@/app/actions/admin";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Membership = {
  id: string;
  company_id: string;
  user_id: string;
  is_active: boolean;
  profiles: { email: string; full_name: string | null } | null;
  membership_inboxes: Array<{ inbox_id: string }>;
  membership_roles: Array<{ role_id: string; roles: { name: string } | null }>;
};

export function UsersManager({
  companies,
  roles,
  inboxes,
  memberships,
}: {
  companies: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string; company_id: string | null }>;
  inboxes: Array<{
    id: string;
    name: string;
    company_id: string;
    phone_number: string;
  }>;
  memberships: Membership[];
}) {
  const router = useRouter();
  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<Membership | null>(null);
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? "");
  const [loading, setLoading] = useState(false);

  const companyRoles = useMemo(
    () => roles.filter((r) => r.company_id === companyId),
    [roles, companyId],
  );
  const companyInboxes = useMemo(
    () => inboxes.filter((i) => i.company_id === companyId),
    [inboxes, companyId],
  );

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const inboxIds = companyInboxes
      .filter((i) => form.get(`inbox_${i.id}`) === "on")
      .map((i) => i.id);

    if (companyInboxes.length === 0) {
      toast.error(
        "Esta empresa no tiene inboxes. Crea un inbox antes de asignar agentes.",
      );
      setLoading(false);
      return;
    }

    if (inboxIds.length === 0) {
      toast.error("Selecciona al menos un inbox para el usuario");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          fullName: form.get("fullName"),
          companyId,
          roleId: form.get("roleId"),
          inboxIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error creando usuario");
      toast.success(
        `Usuario creado con ${data.inboxIds?.length ?? inboxIds.length} inbox(es)`,
      );
      setOpenCreate(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  async function onEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const options = inboxes.filter((i) => i.company_id === editing.company_id);
    const inboxIds = options
      .filter((i) => form.get(`mi_${i.id}`) === "on")
      .map((i) => i.id);
    if (inboxIds.length === 0) {
      toast.error("Selecciona al menos un inbox");
      setLoading(false);
      return;
    }
    try {
      await updateMembership({
        membershipId: editing.id,
        companyId: editing.company_id,
        userId: editing.user_id,
        fullName: String(form.get("fullName") || ""),
        roleId: String(form.get("roleId") || "") || null,
        inboxIds,
        isActive: form.get("isActive") === "on",
      });
      toast.success("Usuario actualizado");
      setEditing(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Usuarios"
        description="Gestiona miembros, roles e inboxes por empresa"
        actions={
          <Button onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4" /> Nuevo usuario
          </Button>
        }
      />

      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Email</TH>
            <TH>Empresa</TH>
            <TH>Rol</TH>
            <TH>Inboxes</TH>
            <TH>Estado</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {memberships.map((m) => {
            const company = companies.find((c) => c.id === m.company_id);
            const role = m.membership_roles?.[0];
            const roleName =
              (Array.isArray(role?.roles) ? role?.roles[0] : role?.roles)
                ?.name || "—";
            return (
              <TR key={m.id}>
                <TD className="font-medium">
                  {m.profiles?.full_name || "—"}
                </TD>
                <TD>{m.profiles?.email}</TD>
                <TD>{company?.name}</TD>
                <TD>
                  <Badge>{roleName}</Badge>
                </TD>
                <TD>{m.membership_inboxes.length}</TD>
                <TD>
                  <Badge
                    className={
                      m.is_active
                        ? "text-emerald-400"
                        : "text-[var(--muted)]"
                    }
                  >
                    {m.is_active ? "Activo" : "Inactivo"}
                  </Badge>
                </TD>
                <TD>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(m)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Crear usuario</DialogTitle>
            <DialogDescription>
              Se creará en Auth y se asignará a la empresa
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={onCreate}>
            <div className="space-y-1.5">
              <Label>Empresa</Label>
              <Select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                required
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Nombre</Label>
              <Input name="fullName" required />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input name="email" type="email" required />
            </div>
            <div className="space-y-1.5">
              <Label>Contraseña</Label>
              <Input name="password" type="password" required minLength={8} />
            </div>
            <div className="space-y-1.5">
              <Label>Rol</Label>
              <Select name="roleId" required>
                {companyRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Inboxes (obligatorio)</Label>
              {companyInboxes.length === 0 ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Esta empresa no tiene inboxes. Ve a Inboxes y crea al menos
                  uno antes de crear agentes.
                </p>
              ) : (
                companyInboxes.map((i, idx) => (
                  <label key={i.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`inbox_${i.id}`}
                      defaultChecked={idx === 0}
                    />
                    {i.name} ({i.phone_number})
                  </label>
                ))
              )}
            </div>
            <Button type="submit" className="w-full" loading={loading}>
              Crear
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar usuario</DialogTitle>
            <DialogDescription>
              {editing?.profiles?.email}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <form className="space-y-3" onSubmit={onEdit}>
              <div className="space-y-1.5">
                <Label>Nombre</Label>
                <Input
                  name="fullName"
                  defaultValue={editing.profiles?.full_name || ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Rol</Label>
                <Select
                  name="roleId"
                  defaultValue={editing.membership_roles?.[0]?.role_id || ""}
                >
                  {roles
                    .filter((r) => r.company_id === editing.company_id)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.is_active}
                />
                Activo
              </label>
              <div className="space-y-2">
                <Label>Inboxes</Label>
                {inboxes
                  .filter((i) => i.company_id === editing.company_id)
                  .map((i) => (
                    <label
                      key={i.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        name={`mi_${i.id}`}
                        defaultChecked={editing.membership_inboxes.some(
                          (x) => x.inbox_id === i.id,
                        )}
                      />
                      {i.name}
                    </label>
                  ))}
              </div>
              <Button type="submit" className="w-full" loading={loading}>
                Guardar cambios
              </Button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
