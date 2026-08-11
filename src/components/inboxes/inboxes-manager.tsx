"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, RefreshCw } from "lucide-react";
import { syncYCloudInboxes, updateInbox } from "@/app/actions/admin";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { ListPagination } from "@/components/ui/list-pagination";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Inbox = {
  id: string;
  name: string;
  phone_number: string;
  is_active: boolean;
  company_id: string | null;
  ycloud_phone_number_id: string | null;
  waba_id: string | null;
  companies: { name: string } | null;
};

export function InboxesManager({
  inboxes,
  companies,
  canSync,
  total,
  page,
  pageSize,
  filters,
}: {
  inboxes: Inbox[];
  companies: Array<{ id: string; name: string }>;
  canSync: boolean;
  total: number;
  page: number;
  pageSize: number;
  filters: { q: string; companyId: string; status: string };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function onSync() {
    setSyncing(true);
    try {
      const result = await syncYCloudInboxes();
      toast.success(
        `Sync OK: ${result.created} nuevos, ${result.updated} actualizados (${result.total} en YCloud)`,
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al sincronizar");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Inboxes"
        description="Números WhatsApp sincronizados desde YCloud"
        actions={
          canSync ? (
            <Button onClick={onSync} loading={syncing}>
              <RefreshCw className="h-4 w-4" /> Sincronizar con YCloud
            </Button>
          ) : null
        }
      />

      <form method="get" className="mb-4 grid gap-3 sm:grid-cols-4">
        <input type="hidden" name="page" value="1" />
        <input type="hidden" name="pageSize" value={String(pageSize)} />
        <div className="space-y-1.5">
          <Label>Buscar</Label>
          <Input
            name="q"
            defaultValue={filters.q}
            placeholder="Nombre o teléfono"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Empresa</Label>
          <Select name="companyId" defaultValue={filters.companyId}>
            <option value="">Todas</option>
            <option value="none">Sin asignar</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
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
            <TH>Número</TH>
            <TH>Empresa</TH>
            <TH>YCloud ID</TH>
            <TH>WABA</TH>
            <TH>Estado</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {inboxes.map((i) => (
            <TR key={i.id}>
              <TD className="font-medium">{i.name}</TD>
              <TD>{i.phone_number}</TD>
              <TD>{i.companies?.name ?? "Sin asignar"}</TD>
              <TD className="max-w-[140px] truncate text-xs text-[var(--muted)]">
                {i.ycloud_phone_number_id || "—"}
              </TD>
              <TD className="max-w-[120px] truncate text-xs text-[var(--muted)]">
                {i.waba_id || "—"}
              </TD>
              <TD>
                <Badge>{i.is_active ? "Activo" : "Inactivo"}</Badge>
              </TD>
              <TD>
                {canSync ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                ) : null}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <ListPagination
        page={page}
        pageSize={pageSize}
        total={total}
        baseParams={{
          q: filters.q || undefined,
          companyId: filters.companyId || undefined,
          status: filters.status !== "all" ? filters.status : undefined,
        }}
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar inbox</DialogTitle>
          </DialogHeader>
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                const form = new FormData(e.currentTarget);
                try {
                  await updateInbox({
                    id: editing.id,
                    name: String(form.get("name")),
                    isActive: form.get("isActive") === "on",
                  });
                  toast.success("Inbox actualizado");
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
                <Label>Teléfono</Label>
                <Input value={editing.phone_number} disabled />
              </div>
              <p className="text-xs text-[var(--muted)]">
                La empresa se asigna desde el CRUD de Empresas.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.is_active}
                />
                Activo
              </label>
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
