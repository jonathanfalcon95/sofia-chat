"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { createCompany, updateCompany } from "@/app/actions/admin";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Company = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
};

export function CompaniesManager({
  companies,
  canManage,
}: {
  companies: Company[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div>
      <PageHeader
        title="Empresas"
        description="Multi-tenant Sofia Chat"
        actions={
          canManage ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Nueva empresa
            </Button>
          ) : null
        }
      />
      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Slug</TH>
            <TH>Estado</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {companies.map((c) => (
            <TR key={c.id}>
              <TD className="font-medium">{c.name}</TD>
              <TD>{c.slug}</TD>
              <TD>
                <Badge>{c.is_active ? "Activa" : "Inactiva"}</Badge>
              </TD>
              <TD>
                {canManage ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
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
                await createCompany(
                  String(form.get("name")),
                  String(form.get("slug")),
                );
                toast.success("Empresa creada");
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
              <Label>Nombre</Label>
              <Input name="name" required />
            </div>
            <div className="space-y-1.5">
              <Label>Slug</Label>
              <Input name="slug" required placeholder="mi-empresa" />
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
                    isActive: form.get("isActive") === "on",
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
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.is_active}
                />
                Activa
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
