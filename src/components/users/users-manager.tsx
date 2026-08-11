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
import { ListPagination } from "@/components/ui/list-pagination";
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
  total,
  page,
  pageSize,
  filters,
}: {
  companies: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string; company_id: string | null }>;
  inboxes: Array<{
    id: string;
    name: string;
    company_id: string;
    phone_number: string;
    is_active?: boolean;
  }>;
  memberships: Membership[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    q: string;
    companyId: string;
    roleId: string;
    status: string;
  };
}) {
  const router = useRouter();
  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<Membership | null>(null);
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? "");
  const [filterCompanyId, setFilterCompanyId] = useState(filters.companyId);
  const [loading, setLoading] = useState(false);

  const filterRoles = useMemo(
    () =>
      filterCompanyId
        ? roles.filter((r) => r.company_id === filterCompanyId)
        : roles,
    [roles, filterCompanyId],
  );

  const companyRoles = useMemo(
    () => roles.filter((r) => r.company_id === companyId),
    [roles, companyId],
  );
  const companyInboxes = useMemo(
    () => inboxes.filter((i) => i.company_id === companyId),
    [inboxes, companyId],
  );
  const singleCreateInbox = companyInboxes.length === 1;

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const inboxIds = singleCreateInbox
      ? [companyInboxes[0].id]
      : companyInboxes
          .filter((i) => form.get(`inbox_${i.id}`) === "on")
          .map((i) => i.id);

    if (companyInboxes.length === 0) {
      toast.error(
        "Esta empresa no tiene números. Asígnalos en Empresas antes de crear usuarios.",
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
    const inboxIds =
      options.length === 1
        ? [options[0].id]
        : options
            .filter((i) => form.get(`mi_${i.id}`) === "on")
            .map((i) => i.id);
    if (options.length === 0) {
      toast.error(
        "Esta empresa no tiene números. Asígnalos en Empresas antes de editar usuarios.",
      );
      setLoading(false);
      return;
    }
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

      <form method="get" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input type="hidden" name="page" value="1" />
        <input type="hidden" name="pageSize" value={String(pageSize)} />
        <div className="space-y-1.5">
          <Label>Buscar</Label>
          <Input
            name="q"
            defaultValue={filters.q}
            placeholder="Nombre o email"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Empresa</Label>
          <Select
            name="companyId"
            value={filterCompanyId}
            onChange={(e) => setFilterCompanyId(e.target.value)}
          >
            <option value="">Todas</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Rol</Label>
          <Select name="roleId" defaultValue={filters.roleId}>
            <option value="">Todos</option>
            {filterRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Estado</Label>
          <Select name="status" defaultValue={filters.status}>
            <option value="all">Todos</option>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
          </Select>
        </div>
        <div className="flex items-end">
          <Button type="submit" variant="secondary" className="w-full">
            Filtrar
          </Button>
        </div>
      </form>

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

      <ListPagination
        page={page}
        pageSize={pageSize}
        total={total}
        baseParams={{
          q: filters.q || undefined,
          companyId: filters.companyId || undefined,
          roleId: filters.roleId || undefined,
          status: filters.status !== "all" ? filters.status : undefined,
        }}
      />

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
                  Esta empresa no tiene números. Asígnalos en Empresas antes de
                  crear usuarios.
                </p>
              ) : singleCreateInbox ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`inbox_${companyInboxes[0].id}`}
                    checked
                    disabled
                    readOnly
                  />
                  {companyInboxes[0].name} ({companyInboxes[0].phone_number})
                  <span className="text-xs text-[var(--muted)]">
                    (único · obligatorio)
                  </span>
                </label>
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
            <Button
              type="submit"
              className="w-full"
              loading={loading}
              disabled={companyInboxes.length === 0}
            >
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
                {(() => {
                  const options = inboxes.filter(
                    (i) => i.company_id === editing.company_id,
                  );
                  if (options.length === 0) {
                    return (
                      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        Esta empresa no tiene números. Asígnalos en Empresas.
                      </p>
                    );
                  }
                  if (options.length === 1) {
                    return (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name={`mi_${options[0].id}`}
                          checked
                          disabled
                          readOnly
                        />
                        {options[0].name} ({options[0].phone_number})
                        <span className="text-xs text-[var(--muted)]">
                          (único · obligatorio)
                        </span>
                      </label>
                    );
                  }
                  return options.map((i) => (
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
                      {i.name} ({i.phone_number})
                    </label>
                  ));
                })()}
              </div>
              <Button
                type="submit"
                className="w-full"
                loading={loading}
                disabled={
                  inboxes.filter((i) => i.company_id === editing.company_id)
                    .length === 0
                }
              >
                Guardar cambios
              </Button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
