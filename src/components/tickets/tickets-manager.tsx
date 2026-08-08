"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { ExternalLink, Ticket } from "lucide-react";
import { toast } from "sonner";
import {
  updateTicketAssignee,
  updateTicketPriority,
  updateTicketStatus,
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
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
  company_name: string;
  assignee: { full_name: string | null; email: string } | null;
  creator: { full_name: string | null; email: string } | null;
  contact: { name: string | null; phone_number: string } | null;
};

type AssigneeFilter = "all" | "mine" | "unassigned";

export function TicketsManager({
  tickets,
  supportAgents,
  currentUserId,
}: {
  tickets: TicketRow[];
  supportAgents: SupportAgent[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>("all");

  const filtered = useMemo(() => {
    return tickets.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (priorityFilter !== "all" && t.priority !== priorityFilter)
        return false;
      if (assigneeFilter === "mine" && t.assignee_id !== currentUserId)
        return false;
      if (assigneeFilter === "unassigned" && t.assignee_id) return false;
      return true;
    });
  }, [tickets, statusFilter, priorityFilter, assigneeFilter, currentUserId]);

  function agentsForCompany(companyId: string) {
    return supportAgents.filter((a) => a.company_id === companyId);
  }

  return (
    <div>
      <PageHeader
        title="Tickets"
        description="Incidencias escaladas a soporte, vinculadas a conversaciones"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-auto min-w-[140px]"
          aria-label="Filtrar por estado"
        >
          <option value="all">Todos los estados</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          className="w-auto min-w-[140px]"
          aria-label="Filtrar por prioridad"
        >
          <option value="all">Todas las prioridades</option>
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        <div className="flex rounded-lg border border-[var(--line)] p-0.5 text-xs">
          {(
            [
              ["all", "Todas"],
              ["mine", "Mías"],
              ["unassigned", "Sin asignar"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setAssigneeFilter(value)}
              className={cn(
                "rounded-md px-2.5 py-1.5 transition",
                assigneeFilter === value
                  ? "bg-[var(--accent-soft)] font-medium text-[var(--ink)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] px-6 py-16 text-center">
          <Ticket className="mb-3 h-8 w-8 text-[var(--muted)]" />
          <p className="text-sm font-medium">Sin tickets</p>
          <p className="mt-1 max-w-sm text-xs text-[var(--muted)]">
            {tickets.length === 0
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
                <TH>Creado</TH>
              </TR>
            </THead>
            <TBody>
              {filtered.map((t) => (
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
                    <div className="flex flex-col gap-1.5">
                      <Badge className={priorityBadgeClass(t.priority)}>
                        {PRIORITY_LABELS[t.priority as TicketPriority] ??
                          t.priority}
                      </Badge>
                      <Select
                        defaultValue={t.priority}
                        disabled={pending}
                        className="h-8 min-w-[110px] text-xs"
                        onChange={(e) => {
                          const value = e.target.value;
                          startTransition(async () => {
                            try {
                              await updateTicketPriority(t.id, value);
                              toast.success("Prioridad actualizada");
                              router.refresh();
                            } catch (err) {
                              toast.error(
                                err instanceof Error ? err.message : "Error",
                              );
                            }
                          });
                        }}
                      >
                        {TICKET_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </TD>
                  <TD>
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
                  </TD>
                  <TD>
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
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
