"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { ExternalLink, Pencil, Ticket } from "lucide-react";
import { toast } from "sonner";
import {
  updateTicketAssignee,
  updateTicketContent,
  updateTicketStatus,
  updateTicketSupportResponse,
} from "@/app/actions/conversations";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  priorityBadgeClass,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/tickets";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

type SupportAgent = {
  id: string;
  full_name: string | null;
  email: string;
  company_id: string;
};

type TicketRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  company_id: string;
  conversation_id: string;
  assignee_id: string | null;
  created_by: string;
  created_at: string;
  support_response: string | null;
  support_responded_at: string | null;
  company_name: string;
  assignee: { full_name: string | null; email: string } | null;
  creator: { full_name: string | null; email: string } | null;
  responder: { full_name: string | null; email: string } | null;
  contact: { name: string | null; phone_number: string } | null;
};

export function TicketsManager({
  tickets,
  supportAgents,
  currentUserId,
  supportCompanyIds,
  isSupportViewer,
  total,
  page,
  pageSize,
  filters,
}: {
  tickets: TicketRow[];
  supportAgents: SupportAgent[];
  currentUserId: string;
  /** null = platform admin (all companies). */
  supportCompanyIds: string[] | null;
  isSupportViewer: boolean;
  total: number;
  page: number;
  pageSize: number;
  filters: {
    q: string;
    status: string;
    priority: string;
    assignee: string;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<TicketRow | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] =
    useState<TicketPriority>("medium");
  const [editResponse, setEditResponse] = useState("");

  function canSupportTicket(companyId: string) {
    if (supportCompanyIds === null) return true;
    return supportCompanyIds.includes(companyId);
  }

  function canEditContent(ticket: TicketRow) {
    if (canSupportTicket(ticket.company_id)) return true;
    return ticket.created_by === currentUserId;
  }

  function agentsForCompany(companyId: string) {
    return supportAgents.filter((a) => a.company_id === companyId);
  }

  function openEdit(ticket: TicketRow) {
    setEditing(ticket);
    setEditTitle(ticket.title);
    setEditDescription(ticket.description ?? "");
    setEditPriority((ticket.priority as TicketPriority) || "medium");
    setEditResponse(ticket.support_response ?? "");
  }

  return (
    <div>
      <PageHeader
        title="Tickets"
        description={
          isSupportViewer
            ? "Cola de soporte: responde, cambia estado y reasigna"
            : "Tus incidencias escaladas. Puedes editar el contenido, no la asignación"
        }
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="page" value="1" />
        <input type="hidden" name="pageSize" value={String(pageSize)} />
        <div className="space-y-1.5">
          <Label>Buscar</Label>
          <Input
            name="q"
            defaultValue={filters.q}
            placeholder="Título o descripción"
            className="min-w-[180px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Estado</Label>
          <Select
            name="status"
            defaultValue={filters.status}
            className="w-auto min-w-[140px]"
          >
            <option value="all">Todos los estados</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Prioridad</Label>
          <Select
            name="priority"
            defaultValue={filters.priority}
            className="w-auto min-w-[140px]"
          >
            <option value="all">Todas las prioridades</option>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </div>
        {isSupportViewer ? (
          <div className="space-y-1.5">
            <Label>Asignación</Label>
            <Select
              name="assignee"
              defaultValue={filters.assignee}
              className="w-auto min-w-[140px]"
            >
              <option value="all">Todas</option>
              <option value="mine">Mías</option>
              <option value="unassigned">Sin asignar</option>
            </Select>
          </div>
        ) : (
          <input type="hidden" name="assignee" value="all" />
        )}
        <Button type="submit" variant="secondary">
          Filtrar
        </Button>
      </form>

      {tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] px-6 py-16 text-center">
          <Ticket className="mb-3 h-8 w-8 text-[var(--muted)]" />
          <p className="text-sm font-medium">Sin tickets</p>
          <p className="mt-1 max-w-sm text-xs text-[var(--muted)]">
            {total === 0
              ? "Cuando un agente escale una incidencia desde el chat, aparecerá aquí."
              : "No hay tickets que coincidan con los filtros actuales."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Ticket</TH>
                <TH>Contacto</TH>
                <TH>Conversación</TH>
                <TH>Empresa</TH>
                <TH>Prioridad</TH>
                <TH>Estado</TH>
                <TH>Asignado</TH>
                <TH>Respuesta</TH>
                <TH>Creado</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {tickets.map((t) => {
                const support = canSupportTicket(t.company_id);
                return (
                  <TR key={t.id}>
                    <TD className="min-w-[200px] max-w-[280px]">
                      <div className="font-medium">{t.title}</div>
                      {t.description ? (
                        <div className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">
                          {t.description}
                        </div>
                      ) : null}
                    </TD>
                    <TD className="min-w-[140px]">
                      <div className="text-sm">
                        {t.contact?.name || "Sin nombre"}
                      </div>
                      {t.contact?.phone_number ? (
                        <div className="text-xs text-[var(--muted)]">
                          {t.contact.phone_number}
                        </div>
                      ) : null}
                    </TD>
                    <TD>
                      <Link
                        href={`/conversations/${t.conversation_id}`}
                        className="inline-flex items-center gap-1 text-sm text-[var(--accent)] hover:underline"
                      >
                        Abrir chat
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </TD>
                    <TD>{t.company_name}</TD>
                    <TD>
                      <Badge className={priorityBadgeClass(t.priority)}>
                        {PRIORITY_LABELS[t.priority as TicketPriority] ??
                          t.priority}
                      </Badge>
                    </TD>
                    <TD>
                      {support ? (
                        <Select
                          defaultValue={t.status}
                          disabled={pending}
                          className="min-w-[130px] text-xs"
                          onChange={(e) => {
                            const value = e.target.value;
                            startTransition(async () => {
                              try {
                                await updateTicketStatus(t.id, value);
                                toast.success("Estado actualizado");
                                router.refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Error",
                                );
                              }
                            });
                          }}
                        >
                          {TICKET_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABELS[s as TicketStatus]}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-sm">
                          {STATUS_LABELS[t.status as TicketStatus] ?? t.status}
                        </span>
                      )}
                    </TD>
                    <TD>
                      {support ? (
                        <Select
                          defaultValue={t.assignee_id ?? ""}
                          disabled={pending}
                          className="min-w-[150px] text-xs"
                          onChange={(e) => {
                            const value = e.target.value || null;
                            startTransition(async () => {
                              try {
                                await updateTicketAssignee(t.id, value);
                                toast.success(
                                  value
                                    ? "Ticket asignado"
                                    : "Ticket sin asignar",
                                );
                                router.refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Error",
                                );
                              }
                            });
                          }}
                        >
                          <option value="">Sin asignar</option>
                          {agentsForCompany(t.company_id).map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.full_name || a.email}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-sm text-[var(--muted)]">
                          {t.assignee?.full_name ||
                            t.assignee?.email ||
                            "Sin asignar"}
                        </span>
                      )}
                    </TD>
                    <TD className="min-w-[160px] max-w-[220px]">
                      {t.support_response ? (
                        <div>
                          <div className="line-clamp-2 text-xs">
                            {t.support_response}
                          </div>
                          {t.responder ? (
                            <div className="mt-0.5 text-[10px] text-[var(--muted)]">
                              {t.responder.full_name || t.responder.email}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--muted)]">
                          Sin respuesta
                        </span>
                      )}
                    </TD>
                    <TD className="min-w-[120px]">
                      <div className="text-xs">
                        {t.creator?.full_name || t.creator?.email || "—"}
                      </div>
                      <div className="text-[10px] text-[var(--muted)]">
                        {formatDistanceToNow(new Date(t.created_at), {
                          addSuffix: true,
                          locale: es,
                        })}
                      </div>
                    </TD>
                    <TD>
                      {canEditContent(t) || support ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(t)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {support ? "Gestionar" : "Editar"}
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}

      <ListPagination
        page={page}
        pageSize={pageSize}
        total={total}
        baseParams={{
          q: filters.q || undefined,
          status: filters.status !== "all" ? filters.status : undefined,
          priority: filters.priority !== "all" ? filters.priority : undefined,
          assignee:
            filters.assignee !== "all" ? filters.assignee : undefined,
        }}
      />

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          {editing ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {canSupportTicket(editing.company_id)
                    ? "Gestionar ticket"
                    : "Editar ticket"}
                </DialogTitle>
                <DialogDescription>
                  {canSupportTicket(editing.company_id)
                    ? "Puedes responder, reasignar y actualizar el estado desde la tabla."
                    : "Puedes modificar el contenido. La asignación la define soporte."}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-title">Título</Label>
                  <Input
                    id="edit-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    disabled={!canEditContent(editing)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-description">Descripción</Label>
                  <Textarea
                    id="edit-description"
                    rows={4}
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    disabled={!canEditContent(editing)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-priority">Prioridad</Label>
                  <Select
                    id="edit-priority"
                    value={editPriority}
                    onChange={(e) =>
                      setEditPriority(e.target.value as TicketPriority)
                    }
                    disabled={!canEditContent(editing)}
                  >
                    {TICKET_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </option>
                    ))}
                  </Select>
                </div>

                {!canSupportTicket(editing.company_id) ? (
                  <p className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--muted)]">
                    Asignado a:{" "}
                    <span className="text-[var(--ink)]">
                      {editing.assignee?.full_name ||
                        editing.assignee?.email ||
                        "Sin asignar (cola de soporte)"}
                    </span>
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-response">Respuesta de soporte</Label>
                    <Textarea
                      id="edit-response"
                      rows={4}
                      value={editResponse}
                      onChange={(e) => setEditResponse(e.target.value)}
                      placeholder="Escribe la respuesta o resolución para el agente…"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setEditing(null)}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      pending || !editTitle.trim() || !editDescription.trim()
                    }
                    onClick={() => {
                      const ticket = editing;
                      startTransition(async () => {
                        try {
                          if (canEditContent(ticket)) {
                            await updateTicketContent(ticket.id, {
                              title: editTitle,
                              description: editDescription,
                              priority: editPriority,
                            });
                          }
                          if (
                            canSupportTicket(ticket.company_id) &&
                            editResponse.trim()
                          ) {
                            await updateTicketSupportResponse(
                              ticket.id,
                              editResponse,
                            );
                          }
                          toast.success("Ticket actualizado");
                          setEditing(null);
                          router.refresh();
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Error",
                          );
                        }
                      });
                    }}
                  >
                    {pending ? "Guardando…" : "Guardar"}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
