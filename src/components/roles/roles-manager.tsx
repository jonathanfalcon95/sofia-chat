"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { createRole, updateRole } from "@/app/actions/admin";
import {
  PERMISSIONS,
  PERMISSION_LABELS,
  isPlatformPermission,
} from "@/lib/rbac/permissions";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ListPagination } from "@/components/ui/list-pagination";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  company_id: string;
  companies: { name: string } | null;
  codes: string[];
};

export function RolesManager({
  roles,
  companies,
  permissions,
  total,
  page,
  pageSize,
  filters,
  isPlatformAdmin = false,
}: {
  roles: RoleRow[];
  companies: Array<{ id: string; name: string }>;
  permissions: Array<{ code: string; description: string }>;
  total: number;
  page: number;
  pageSize: number;
  filters: { q: string; companyId: string };
  isPlatformAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div>
      <PageHeader
        title="Roles y permisos"
        description="Roles por empresa con permisos granulares"
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Nuevo rol
          </Button>
        }
      />

      <form method="get" className="mb-4 grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="page" value="1" />
        <input type="hidden" name="pageSize" value={String(pageSize)} />
        <div className="space-y-1.5">
          <Label>Buscar</Label>
          <Input name="q" defaultValue={filters.q} placeholder="Nombre del rol" />
        </div>
        <div className="space-y-1.5">
          <Label>Empresa</Label>
          <Select name="companyId" defaultValue={filters.companyId}>
            <option value="">Todas</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="secondary" className="w-full">
            Filtrar
          </Button>
        </div>
      </form>

      <div className="grid gap-3">
        {roles.map((role) => (
          <div
            key={role.id}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>
                  {role.name} · {role.companies?.name}
                </strong>
                <p className="text-sm text-[var(--muted)]">
                  {role.description}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {role.is_system ? <Badge>Sistema</Badge> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(role)}
                >
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {role.codes.map((code) => (
                <Badge key={code}>{code}</Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      <ListPagination
        page={page}
        pageSize={pageSize}
        total={total}
        baseParams={{
          q: filters.q || undefined,
          companyId: filters.companyId || undefined,
        }}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Nuevo rol</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              const form = new FormData(e.currentTarget);
              const permissionCodes = PERMISSIONS.filter(
                (code) => form.get(`perm_${code}`) === "on",
              );
              try {
                await createRole({
                  companyId: String(form.get("companyId")),
                  name: String(form.get("name")),
                  description: String(form.get("description") || ""),
                  permissionCodes: [...permissionCodes],
                });
                toast.success("Rol creado");
                setOpen(false);
                router.refresh();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Error");
              } finally {
                setLoading(false);
              }
            }}
          >
            <div className="space-y-1.5">
              <Label>Empresa</Label>
              <Select name="companyId" required>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Nombre</Label>
              <Input name="name" required />
            </div>
            <div className="space-y-1.5">
              <Label>Descripción</Label>
              <Input name="description" />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {permissions
                .filter(
                  (p) => isPlatformAdmin || !isPlatformPermission(p.code),
                )
                .map((p) => (
                  <label key={p.code} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name={`perm_${p.code}`} />
                    {PERMISSION_LABELS[p.code as keyof typeof PERMISSION_LABELS] ||
                      p.code}
                  </label>
                ))}
            </div>
            <Button type="submit" className="w-full" loading={loading}>
              Crear
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Editar rol</DialogTitle>
          </DialogHeader>
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                const form = new FormData(e.currentTarget);
                const permissionCodes = PERMISSIONS.filter(
                  (code) => form.get(`perm_${code}`) === "on",
                );
                try {
                  await updateRole({
                    id: editing.id,
                    companyId: editing.company_id,
                    name: String(form.get("name")),
                    description: String(form.get("description") || ""),
                    permissionCodes: [...permissionCodes],
                  });
                  toast.success("Rol actualizado");
                  setEditing(null);
                  router.refresh();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Error");
                } finally {
                  setLoading(false);
                }
              }}
            >
              <div className="space-y-1.5">
                <Label>Nombre</Label>
                <Input name="name" defaultValue={editing.name} required />
              </div>
              <div className="space-y-1.5">
                <Label>Descripción</Label>
                <Input
                  name="description"
                  defaultValue={editing.description || ""}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {permissions
                  .filter(
                    (p) =>
                      isPlatformAdmin ||
                      !isPlatformPermission(p.code) ||
                      editing.codes.includes(p.code),
                  )
                  .map((p) => {
                    const locked =
                      !isPlatformAdmin && isPlatformPermission(p.code);
                    return (
                      <label
                        key={p.code}
                        className={`flex items-center gap-2 text-sm${locked ? " opacity-60" : ""}`}
                      >
                        <input
                          type="checkbox"
                          name={`perm_${p.code}`}
                          defaultChecked={editing.codes.includes(p.code)}
                          disabled={locked}
                        />
                        {PERMISSION_LABELS[
                          p.code as keyof typeof PERMISSION_LABELS
                        ] || p.code}
                      </label>
                    );
                  })}
              </div>
              <Button type="submit" className="w-full" loading={loading}>
                Guardar
              </Button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
