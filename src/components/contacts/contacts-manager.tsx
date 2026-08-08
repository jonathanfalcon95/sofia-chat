"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { updateContact } from "@/app/actions/admin";
import {
  createContactTag,
  deleteContactTag,
  setContactTags,
} from "@/app/actions/tags";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ContactTag = {
  id: string;
  name: string;
  color: string;
  company_id: string;
};

type Contact = {
  id: string;
  name: string | null;
  phone_number: string;
  company_id: string;
  companies: { name: string } | null;
  contact_tags: Array<{
    tag_id: string;
    tags: { id: string; name: string; color: string } | null;
  }>;
};

export function ContactsManager({
  contacts,
  contactTags,
  companies,
  canManageTags,
  canAssignTags,
}: {
  contacts: Contact[];
  contactTags: ContactTag[];
  companies: Array<{ id: string; name: string }>;
  canManageTags: boolean;
  canAssignTags: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterTagId, setFilterTagId] = useState("");
  const [tagName, setTagName] = useState("");
  const [tagColor, setTagColor] = useState("#3b82f6");
  const [tagCompanyId, setTagCompanyId] = useState(companies[0]?.id ?? "");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const filtered = useMemo(() => {
    if (!filterTagId) return contacts;
    return contacts.filter((c) =>
      c.contact_tags.some((t) => t.tag_id === filterTagId),
    );
  }, [contacts, filterTagId]);

  function openEdit(c: Contact) {
    setEditing(c);
    setSelectedTagIds(c.contact_tags.map((t) => t.tag_id));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contactos"
        description="Contactos sincronizados desde WhatsApp con tags personalizados"
        actions={
          <Select
            value={filterTagId}
            onChange={(e) => setFilterTagId(e.target.value)}
            className="min-w-[180px]"
          >
            <option value="">Todos los tags</option>
            {contactTags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        }
      />

      {canManageTags ? (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold">Tags de contacto</h2>
              <p className="text-xs text-[var(--muted)]">
                Independientes del Kanban. Varios por contacto.
              </p>
            </div>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {contactTags.map((t) => (
              <div
                key={t.id}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2 py-1 text-xs"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: t.color }}
                />
                {t.name}
                <button
                  type="button"
                  className="ml-1 text-[var(--muted)] hover:text-[var(--danger)]"
                  onClick={async () => {
                    try {
                      await deleteContactTag(t.id, t.company_id);
                      toast.success("Tag eliminado");
                      router.refresh();
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Error");
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await createContactTag({
                  companyId: tagCompanyId,
                  name: tagName,
                  color: tagColor,
                });
                setTagName("");
                toast.success("Tag creado");
                router.refresh();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Error");
              }
            }}
          >
            {companies.length > 1 ? (
              <div className="space-y-1">
                <Label>Empresa</Label>
                <Select
                  value={tagCompanyId}
                  onChange={(e) => setTagCompanyId(e.target.value)}
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                placeholder="VIP"
                required
              />
            </div>
            <div className="space-y-1">
              <Label>Color</Label>
              <Input
                type="color"
                value={tagColor}
                onChange={(e) => setTagColor(e.target.value)}
                className="h-10 w-14 p-1"
              />
            </div>
            <Button type="submit">
              <Plus className="h-4 w-4" /> Crear tag
            </Button>
          </form>
        </div>
      ) : null}

      <Table>
        <THead>
          <TR>
            <TH>Nombre</TH>
            <TH>Teléfono</TH>
            <TH>Tags</TH>
            <TH>Empresa</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {filtered.map((c) => (
            <TR key={c.id}>
              <TD className="font-medium">{c.name || "—"}</TD>
              <TD>{c.phone_number}</TD>
              <TD>
                <div className="flex flex-wrap gap-1">
                  {c.contact_tags.map((ct) =>
                    ct.tags ? (
                      <Badge
                        key={ct.tag_id}
                        style={{
                          background: `${ct.tags.color}22`,
                          color: ct.tags.color,
                          borderColor: `${ct.tags.color}55`,
                        }}
                      >
                        {ct.tags.name}
                      </Badge>
                    ) : null,
                  )}
                </div>
              </TD>
              <TD>{c.companies?.name}</TD>
              <TD>
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar contacto</DialogTitle>
          </DialogHeader>
          {editing ? (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setLoading(true);
                const form = new FormData(e.currentTarget);
                try {
                  await updateContact({
                    id: editing.id,
                    name: String(form.get("name")),
                    phoneNumber: String(form.get("phoneNumber")),
                  });
                  if (canAssignTags) {
                    await setContactTags(editing.id, selectedTagIds);
                  }
                  toast.success("Contacto actualizado");
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
                <Input name="name" defaultValue={editing.name || ""} />
              </div>
              <div className="space-y-1.5">
                <Label>Teléfono</Label>
                <Input
                  name="phoneNumber"
                  defaultValue={editing.phone_number}
                  required
                />
              </div>
              {canAssignTags ? (
                <div className="space-y-1.5">
                  <Label>Tags</Label>
                  <div className="max-h-40 space-y-1.5 overflow-auto rounded-lg border border-[var(--line)] p-2">
                    {contactTags
                      .filter((t) => t.company_id === editing.company_id)
                      .map((t) => (
                        <label
                          key={t.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selectedTagIds.includes(t.id)}
                            onChange={(e) =>
                              setSelectedTagIds((prev) =>
                                e.target.checked
                                  ? [...prev, t.id]
                                  : prev.filter((id) => id !== t.id),
                              )
                            }
                          />
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: t.color }}
                          />
                          {t.name}
                        </label>
                      ))}
                  </div>
                </div>
              ) : null}
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
