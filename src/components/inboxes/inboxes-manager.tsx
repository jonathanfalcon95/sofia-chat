"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { createInbox, updateInbox } from "@/app/actions/admin";
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

type Inbox = {
  id: string;
  name: string;
  phone_number: string;
  is_active: boolean;
  company_id: string;
  ycloud_phone_number_id: string | null;
  waba_id: string | null;
  companies: { name: string } | null;
};

export function InboxesManager({
  inboxes,
  companies,
}: {
  inboxes: Inbox[];
  companies: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div>
      <PageHeader
        title="Inboxes"
        description="Números WhatsApp de YCloud por empresa"
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Nuevo inbox
          </Button>
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Número</TH>
            <TH>Empresa</TH>
            <TH>Estado</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {inboxes.map((i) => (
            <TR key={i.id}>
              <TD className="font-medium">{i.name}</TD>
              <TD>{i.phone_number}</TD>
              <TD>{i.companies?.name}</TD>
              <TD>
                <Badge>{i.is_active ? "Activo" : "Inactivo"}</Badge>
              </TD>
              <TD>
                <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuevo inbox</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              const form = new FormData(e.currentTarget);
              try {
                await createInbox({
                  companyId: String(form.get("companyId")),
                  name: String(form.get("name")),
                  phoneNumber: String(form.get("phoneNumber")),
                  ycloudPhoneNumberId: String(
                    form.get("ycloudPhoneNumberId") || "",
                  ),
                  wabaId: String(form.get("wabaId") || ""),
                });
                toast.success("Inbox creado");
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
              <Label>Teléfono E.164</Label>
              <Input name="phoneNumber" required placeholder="+58..." />
            </div>
            <div className="space-y-1.5">
              <Label>YCloud Phone Number ID</Label>
              <Input name="ycloudPhoneNumberId" />
            </div>
            <div className="space-y-1.5">
              <Label>WABA ID</Label>
              <Input name="wabaId" />
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
                    companyId: editing.company_id,
                    name: String(form.get("name")),
                    phoneNumber: String(form.get("phoneNumber")),
                    isActive: form.get("isActive") === "on",
                    ycloudPhoneNumberId: String(
                      form.get("ycloudPhoneNumberId") || "",
                    ),
                    wabaId: String(form.get("wabaId") || ""),
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
                <Input
                  name="phoneNumber"
                  defaultValue={editing.phone_number}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>YCloud Phone Number ID</Label>
                <Input
                  name="ycloudPhoneNumberId"
                  defaultValue={editing.ycloud_phone_number_id || ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label>WABA ID</Label>
                <Input name="wabaId" defaultValue={editing.waba_id || ""} />
              </div>
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
