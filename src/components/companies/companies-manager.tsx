"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { createCompany, updateCompany } from "@/app/actions/admin";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type InboxOption = {
  id: string;
  name: string;
  phone_number: string;
  company_id: string | null;
  is_active: boolean;
};

type Company = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  guid_company: string | null;
  inbox_ids: string[];
  inbox_count: number;
};

function InboxChecklist({
  options,
  selectedIds,
  onChange,
}: {
  options: InboxOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  if (options.length === 0) {
    return (
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        No hay números disponibles. Sincroniza YCloud en Inboxes primero.
      </p>
    );
  }

  return (
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-[var(--border)] p-3">
      {options.map((i) => {
        const checked = selectedIds.includes(i.id);
        return (
          <label key={i.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                if (e.target.checked) {
                  onChange([...selectedIds, i.id]);
                } else {
                  onChange(selectedIds.filter((id) => id !== i.id));
                }
              }}
            />
            <span>
              {i.name} ({i.phone_number})
              {!i.is_active ? " · inactivo" : ""}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function CompaniesManager({
  companies,
  inboxes,
  canManage,
}: {
  companies: Company[];
  inboxes: InboxOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
    "all",
  );
  const [numbersFilter, setNumbersFilter] = useState<"all" | "with" | "without">(
    "all",
  );
  const [createInboxIds, setCreateInboxIds] = useState<string[]>([]);
  const [editInboxIds, setEditInboxIds] = useState<string[]>([]);

  const poolInboxes = useMemo(
    () => inboxes.filter((i) => i.company_id == null),
    [inboxes],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((c) => {
      if (statusFilter === "active" && !c.is_active) return false;
      if (statusFilter === "inactive" && c.is_active) return false;
      if (numbersFilter === "with" && c.inbox_count === 0) return false;
      if (numbersFilter === "without" && c.inbox_count > 0) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q) ||
        (c.guid_company || "").toLowerCase().includes(q)
      );
    });
  }, [companies, query, statusFilter, numbersFilter]);

  function optionsForCompany(companyId: string | null) {
    return inboxes.filter(
      (i) => i.company_id == null || (companyId != null && i.company_id === companyId),
    );
  }

  return (
    <div>
      <PageHeader
        title="Empresas"
        description="Multi-tenant Sofia Chat"
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setCreateInboxIds([]);
                setOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Nueva empresa
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>Buscar</Label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nombre, slug o GUID"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Estado</Label>
          <Select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "all" | "active" | "inactive")
            }
          >
            <option value="all">Todas</option>
            <option value="active">Activas</option>
            <option value="inactive">Inactivas</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Números</Label>
          <Select
            value={numbersFilter}
            onChange={(e) =>
              setNumbersFilter(e.target.value as "all" | "with" | "without")
            }
          >
            <option value="all">Todas</option>
            <option value="with">Con números</option>
            <option value="without">Sin números</option>
          </Select>
        </div>
      </div>

      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Slug</TH>
            <TH>GUID</TH>
            <TH>Números</TH>
            <TH>Estado</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {filtered.map((c) => (
            <TR key={c.id}>
              <TD className="font-medium">{c.name}</TD>
              <TD>{c.slug}</TD>
              <TD className="max-w-[160px] truncate text-xs text-[var(--muted)]">
                {c.guid_company || "—"}
              </TD>
              <TD>{c.inbox_count}</TD>
              <TD>
                <Badge>{c.is_active ? "Activa" : "Inactiva"}</Badge>
              </TD>
              <TD>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(c);
                      setEditInboxIds(c.inbox_ids);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                ) : null}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nueva empresa</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              const form = new FormData(e.currentTarget);
              try {
                await createCompany({
                  name: String(form.get("name")),
                  slug: String(form.get("slug")),
                  guidCompany: String(form.get("guidCompany") || "") || null,
                  inboxIds: createInboxIds,
                });
                toast.success("Empresa creada");
                setOpen(false);
                setCreateInboxIds([]);
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
              <Input name="name" required />
            </div>
            <div className="space-y-1.5">
              <Label>Slug</Label>
              <Input name="slug" required placeholder="mi-empresa" />
            </div>
            <div className="space-y-1.5">
              <Label>GUID empresa</Label>
              <Input name="guidCompany" placeholder="Opcional" />
            </div>
            <div className="space-y-1.5">
              <Label>Números WhatsApp</Label>
              <InboxChecklist
                options={poolInboxes}
                selectedIds={createInboxIds}
                onChange={setCreateInboxIds}
              />
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
            <DialogTitle>Editar empresa</DialogTitle>
          </DialogHeader>
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                const form = new FormData(e.currentTarget);
                try {
                  await updateCompany({
                    id: editing.id,
                    name: String(form.get("name")),
                    slug: String(form.get("slug")),
                    guidCompany: String(form.get("guidCompany") || "") || null,
                    isActive: form.get("isActive") === "on",
                    inboxIds: editInboxIds,
                  });
                  toast.success("Empresa actualizada");
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
                <Label>Slug</Label>
                <Input name="slug" defaultValue={editing.slug} required />
              </div>
              <div className="space-y-1.5">
                <Label>GUID empresa</Label>
                <Input
                  name="guidCompany"
                  defaultValue={editing.guid_company || ""}
                  placeholder="Opcional"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.is_active}
                />
                Activa
              </label>
              <div className="space-y-1.5">
                <Label>Números WhatsApp</Label>
                <InboxChecklist
                  options={optionsForCompany(editing.id)}
                  selectedIds={editInboxIds}
                  onChange={setEditInboxIds}
                />
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
