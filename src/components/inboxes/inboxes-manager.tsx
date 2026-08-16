"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, RefreshCw } from "lucide-react";
import {
  registerYCloudWebhook,
  saveYCloudAccount,
  syncYCloudInboxes,
  updateInbox,
} from "@/app/actions/admin";
import type { YCloudAccountPublic } from "@/lib/ycloud/types";
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
  ycloud_account_id: string | null;
  ycloud_account_name: string | null;
  companies: { name: string } | null;
};

export function InboxesManager({
  inboxes,
  companies,
  accounts,
  canSync,
  total,
  page,
  pageSize,
  filters,
}: {
  inboxes: Inbox[];
  companies: Array<{ id: string; name: string }>;
  accounts: YCloudAccountPublic[];
  canSync: boolean;
  total: number;
  page: number;
  pageSize: number;
  filters: {
    q: string;
    companyId: string;
    status: string;
    ycloudAccountId: string;
  };
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Inbox | null>(null);
  const [accountForm, setAccountForm] = useState<YCloudAccountPublic | "new" | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const selectedAccount =
    accounts.find((a) => a.id === filters.ycloudAccountId) ?? null;

  async function onSync() {
    if (!filters.ycloudAccountId) {
      toast.error("Selecciona una cuenta YCloud para sincronizar");
      return;
    }
    setSyncing(true);
    try {
      const result = await syncYCloudInboxes(filters.ycloudAccountId);
      const skipped =
        result.skipped > 0 ? `, ${result.skipped} omitidos (conflicto)` : "";
      toast.success(
        `Sync OK: ${result.created} nuevos, ${result.updated} actualizados${skipped} (${result.total} en YCloud)`,
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
        description="Números WhatsApp sincronizados desde cada cuenta YCloud"
        actions={
          canSync ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setAccountForm("new")}
              >
                <Plus className="h-4 w-4" /> Cuenta YCloud
              </Button>
              <Button onClick={onSync} loading={syncing}>
                <RefreshCw className="h-4 w-4" /> Sincronizar con YCloud
              </Button>
            </>
          ) : null
        }
      />

      {canSync && selectedAccount ? (
        <p className="mb-4 text-xs text-[var(--muted)]">
          Webhook: {selectedAccount.webhookUrl}
        </p>
      ) : null}

      <form method="get" className="mb-4 grid gap-3 sm:grid-cols-5">
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
        {canSync ? (
          <div className="space-y-1.5">
            <Label>Cuenta YCloud</Label>
            <Select
              name="ycloudAccountId"
              defaultValue={filters.ycloudAccountId}
            >
              <option value="">Todas</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.apiKeyLast4 ? ` · …${a.apiKeyLast4}` : ""}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
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

      {canSync && accounts.length > 0 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {accounts.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={a.id === filters.ycloudAccountId ? "default" : "ghost"}
              onClick={() => setAccountForm(a)}
            >
              Editar {a.name}
            </Button>
          ))}
        </div>
      ) : null}

      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Número</TH>
            <TH>Cuenta YCloud</TH>
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
              <TD>{i.ycloud_account_name ?? "—"}</TD>
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
          ycloudAccountId: filters.ycloudAccountId || undefined,
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

      <Dialog
        open={accountForm !== null}
        onOpenChange={(o) => !o && setAccountForm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {accountForm === "new" ? "Nueva cuenta YCloud" : "Editar cuenta YCloud"}
            </DialogTitle>
          </DialogHeader>
          {accountForm ? (
            <AccountForm
              account={accountForm === "new" ? null : accountForm}
              loading={loading}
              onCancel={() => setAccountForm(null)}
              onSubmit={async (input) => {
                setLoading(true);
                try {
                  const result = await saveYCloudAccount(input);
                  toast.success(
                    result.webhook.created
                      ? "Cuenta guardada y webhook creado en YCloud"
                      : "Cuenta guardada y webhook actualizado en YCloud",
                  );
                  setAccountForm(null);
                  router.refresh();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Error");
                } finally {
                  setLoading(false);
                }
              }}
              onRegisterWebhook={
                accountForm === "new"
                  ? undefined
                  : async () => {
                      setLoading(true);
                      try {
                        const webhook = await registerYCloudWebhook(accountForm.id);
                        toast.success(
                          webhook.created
                            ? "Webhook creado en YCloud"
                            : "Webhook actualizado en YCloud",
                        );
                        router.refresh();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Error");
                      } finally {
                        setLoading(false);
                      }
                    }
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AccountForm({
  account,
  loading,
  onSubmit,
  onCancel,
  onRegisterWebhook,
}: {
  account: YCloudAccountPublic | null;
  loading: boolean;
  onSubmit: (input: {
    id?: string;
    name: string;
    apiKey?: string;
    webhookSecret?: string;
    isActive?: boolean;
  }) => Promise<void>;
  onCancel: () => void;
  onRegisterWebhook?: () => Promise<void>;
}) {
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const apiKey = String(form.get("apiKey") ?? "").trim();
        const webhookSecret = String(form.get("webhookSecret") ?? "").trim();
        await onSubmit({
          id: account?.id,
          name: String(form.get("name") ?? "").trim(),
          apiKey: apiKey || undefined,
          webhookSecret: webhookSecret || undefined,
          isActive: form.get("isActive") === "on",
        });
      }}
    >
      <div className="space-y-1.5">
        <Label>Nombre</Label>
        <Input
          name="name"
          defaultValue={account?.name ?? ""}
          placeholder="YCloud 2"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label>API key</Label>
        <Input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder={
            account?.apiKeyLast4
              ? `••••••••${account.apiKeyLast4} (deja vacío para no cambiar)`
              : "API key de YCloud"
          }
          required={!account}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Webhook secret (opcional)</Label>
        <Input
          name="webhookSecret"
          type="password"
          autoComplete="off"
          placeholder={
            account?.hasWebhookSecret
              ? "Ya guardado (deja vacío para no cambiar)"
              : "whsec_… si ya existe en YCloud"
          }
        />
      </div>
      {account ? (
        <p className="break-all text-xs text-[var(--muted)]">
          URL webhook: {account.webhookUrl}
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          defaultChecked={account?.isActive ?? true}
        />
        Activa
      </label>
      <div className="flex flex-col gap-2">
        <Button type="submit" className="w-full" loading={loading}>
          Guardar y registrar webhook
        </Button>
        {onRegisterWebhook ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={loading}
            onClick={() => onRegisterWebhook()}
          >
            Solo actualizar webhook en YCloud
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
