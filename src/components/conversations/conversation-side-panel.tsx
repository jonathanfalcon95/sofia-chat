"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Ticket, Trash2 } from "lucide-react";
import {
  addConversationNote,
  assignConversation,
  deleteConversationNote,
  setConversationTag,
} from "@/app/actions/conversations";
import { setContactTags } from "@/app/actions/tags";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type {
  ConversationRow,
  NoteRow,
} from "@/lib/conversations/types";
import { normalizeNotes } from "@/lib/conversations/normalize";

type Agent = {
  id: string;
  full_name: string | null;
  email: string;
  company_id: string;
};

type Tag = {
  id: string;
  name: string;
  color: string;
  company_id: string;
};

export function ConversationSidePanel({
  active,
  agents,
  tags,
  contactTags,
  notes,
  note,
  onNoteChange,
  onNotesChange,
  onConversationsChange,
  savingTagId,
  onSavingTagIdChange,
  onOpenTicket,
}: {
  active: ConversationRow;
  agents: Agent[];
  tags: Tag[];
  contactTags: Tag[];
  notes: NoteRow[];
  note: string;
  onNoteChange: (value: string) => void;
  onNotesChange: (notes: NoteRow[]) => void;
  onConversationsChange: (
    updater: (prev: ConversationRow[]) => ConversationRow[],
  ) => void;
  savingTagId: string | null;
  onSavingTagIdChange: (id: string | null) => void;
  onOpenTicket: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [savingNote, setSavingNote] = useState(false);
  const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
  const [savingKanbanTag, setSavingKanbanTag] = useState(false);

  const companyAgents = agents.filter((a) => a.company_id === active.company_id);
  const companyKanbanTags = tags.filter((t) => t.company_id === active.company_id);
  const kanbanTagId =
    active.conversation_tags?.find((ct) =>
      companyKanbanTags.some((t) => t.id === ct.tag_id),
    )?.tag_id ?? "";

  async function saveNote() {
    const body = note.trim();
    if (!body || savingNote || deletingNoteId) return;

    const tempId = `temp-note-${crypto.randomUUID()}`;
    const optimistic: NoteRow = {
      id: tempId,
      body,
      created_at: new Date().toISOString(),
      profiles: { full_name: "Tú", email: "" },
    };
    const previous = notes;
    onNotesChange([optimistic, ...notes]);
    onNoteChange("");
    setSavingNote(true);

    try {
      const created = await addConversationNote(
        active.id,
        active.company_id,
        body,
      );
      const normalized = normalizeNotes([
        created as unknown as Record<string, unknown>,
      ])[0];
      onNotesChange([
        normalized ?? {
          id: (created as { id: string }).id,
          body,
          created_at: (created as { created_at: string }).created_at,
          profiles: null,
        },
        ...previous,
      ]);
      toast.success("Nota guardada");
    } catch (err) {
      onNotesChange(previous);
      onNoteChange(body);
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setSavingNote(false);
    }
  }

  async function removeNote(noteId: string) {
    if (savingNote || deletingNoteId) return;
    if (!window.confirm("¿Eliminar esta nota?")) return;

    const previous = notes;
    onNotesChange(notes.filter((n) => n.id !== noteId));
    setDeletingNoteId(noteId);

    try {
      await deleteConversationNote(noteId, active.id);
      toast.success("Nota eliminada");
    } catch (err) {
      onNotesChange(previous);
      toast.error(err instanceof Error ? err.message : "Error");
    } finally {
      setDeletingNoteId(null);
    }
  }

  function updateKanbanTag(nextTagId: string) {
    if (!nextTagId || savingKanbanTag) return;
    const previousTags = active.conversation_tags;
    const tag = companyKanbanTags.find((t) => t.id === nextTagId);
    onConversationsChange((prev) =>
      prev.map((c) =>
        c.id === active.id
          ? {
              ...c,
              conversation_tags: tag
                ? [
                    {
                      tag_id: tag.id,
                      tags: {
                        id: tag.id,
                        name: tag.name,
                        color: tag.color,
                      },
                    },
                  ]
                : [],
            }
          : c,
      ),
    );
    setSavingKanbanTag(true);
    void (async () => {
      try {
        await setConversationTag(active.id, nextTagId);
        toast.success("Etiqueta actualizada");
      } catch (err) {
        onConversationsChange((prev) =>
          prev.map((c) =>
            c.id === active.id
              ? { ...c, conversation_tags: previousTags }
              : c,
          ),
        );
        toast.error(err instanceof Error ? err.message : "Error");
      } finally {
        setSavingKanbanTag(false);
      }
    })();
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Asignar agente</Label>
        <Select
          value={active.assignee_id ?? ""}
          onChange={(e) =>
            startTransition(async () => {
              try {
                await assignConversation(active.id, e.target.value || null);
                onConversationsChange((prev) =>
                  prev.map((c) =>
                    c.id === active.id
                      ? { ...c, assignee_id: e.target.value || null }
                      : c,
                  ),
                );
                toast.success("Conversación asignada");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Error");
              }
            })
          }
        >
          <option value="">Sin asignar</option>
          {companyAgents.map((a) => (
            <option key={`${a.company_id}-${a.id}`} value={a.id}>
              {a.full_name || a.email}
            </option>
          ))}
        </Select>
        <p className="text-[11px] text-[var(--muted)]">
          Solo usuarios con rol Agente de esta empresa
        </p>
      </div>

      <div className="space-y-2">
        <Label className="inline-flex items-center gap-2">
          Etiqueta / Kanban
          {savingKanbanTag ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
          ) : null}
        </Label>
        <Select
          value={kanbanTagId}
          disabled={savingKanbanTag}
          onChange={(e) => updateKanbanTag(e.target.value)}
        >
          <option value="" disabled>
            Seleccionar
          </option>
          {companyKanbanTags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>

      {active.contacts?.id ? (
        <div className="space-y-2">
          <Label>Tags del contacto</Label>
          <div className="space-y-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2">
            {contactTags
              .filter((t) => t.company_id === active.company_id)
              .map((t) => {
                const checked = Boolean(
                  active.contacts?.contact_tags?.some((ct) => ct.tag_id === t.id),
                );
                const busy = savingTagId === t.id;
                return (
                  <label
                    key={t.id}
                    className={`flex min-h-11 items-center gap-2 text-sm ${
                      busy ? "cursor-wait opacity-70" : "cursor-pointer"
                    }`}
                  >
                    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                      ) : (
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5"
                          checked={checked}
                          disabled={Boolean(savingTagId)}
                          onChange={(e) => {
                            const contactId = active.contacts!.id;
                            const current =
                              active.contacts?.contact_tags?.map(
                                (ct) => ct.tag_id,
                              ) ?? [];
                            const next = e.target.checked
                              ? [...current, t.id]
                              : current.filter((id) => id !== t.id);
                            const previous = active.contacts?.contact_tags ?? [];
                            const selected = contactTags
                              .filter((ct) => next.includes(ct.id))
                              .map((ct) => ({
                                tag_id: ct.id,
                                tags: {
                                  id: ct.id,
                                  name: ct.name,
                                  color: ct.color,
                                },
                              }));
                            onConversationsChange((prev) =>
                              prev.map((c) =>
                                c.contacts?.id === contactId
                                  ? {
                                      ...c,
                                      contacts: c.contacts
                                        ? {
                                            ...c.contacts,
                                            contact_tags: selected,
                                          }
                                        : c.contacts,
                                    }
                                  : c,
                              ),
                            );
                            onSavingTagIdChange(t.id);
                            void (async () => {
                              try {
                                await setContactTags(contactId, next);
                                toast.success("Tags actualizados");
                              } catch (err) {
                                onConversationsChange((prev) =>
                                  prev.map((c) =>
                                    c.contacts?.id === contactId
                                      ? {
                                          ...c,
                                          contacts: c.contacts
                                            ? {
                                                ...c.contacts,
                                                contact_tags: previous,
                                              }
                                            : c.contacts,
                                        }
                                      : c,
                                  ),
                                );
                                toast.error(
                                  err instanceof Error ? err.message : "Error",
                                );
                              } finally {
                                onSavingTagIdChange(null);
                              }
                            })();
                          }}
                        />
                      )}
                    </span>
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: t.color }}
                    />
                    {t.name}
                  </label>
                );
              })}
            {contactTags.filter((t) => t.company_id === active.company_id)
              .length === 0 ? (
              <p className="text-xs text-[var(--muted)]">
                No hay tags. Créalos en Contactos.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label>Nota interna</Label>
        <Textarea
          rows={3}
          value={note}
          disabled={savingNote}
          onChange={(e) => onNoteChange(e.target.value)}
        />
        <Button
          variant="secondary"
          className="w-full min-h-11"
          disabled={!note.trim() || savingNote || Boolean(deletingNoteId) || pending}
          onClick={() => void saveNote()}
        >
          {savingNote ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Guardando…
            </>
          ) : (
            "Guardar nota"
          )}
        </Button>
      </div>

      <div className="space-y-2">
        {notes.map((n) => {
          const deleting = deletingNoteId === n.id;
          return (
            <div
              key={n.id}
              className={`rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs ${
                deleting ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <strong>{n.profiles?.full_name || n.profiles?.email || "Nota"}</strong>
                <button
                  type="button"
                  aria-label="Eliminar nota"
                  disabled={savingNote || Boolean(deletingNoteId) || n.id.startsWith("temp-")}
                  onClick={() => void removeNote(n.id)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted)] transition hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                >
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <p className="mt-1">{n.body}</p>
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--line)] pt-4">
        <button
          type="button"
          onClick={onOpenTicket}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)] transition hover:border-[var(--accent)]/40 hover:bg-[var(--accent-soft)]/40 hover:text-[var(--ink)]"
        >
          <Ticket className="h-3.5 w-3.5" />
          Escalar a soporte
        </button>
      </div>
    </div>
  );
}
