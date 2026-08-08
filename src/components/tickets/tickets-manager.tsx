"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateTicketStatus } from "@/app/actions/conversations";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type Ticket = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  companies: { name: string } | null;
  profiles: { full_name: string | null; email: string } | null;
};

export function TicketsManager({ tickets }: { tickets: Ticket[] }) {
  const router = useRouter();

  return (
    <div>
      <PageHeader
        title="Tickets"
        description="Soporte interno vinculado a conversaciones"
      />
      <Table>
        <THead>
          <TR>
            <TH>Título</TH>
            <TH>Empresa</TH>
            <TH>Prioridad</TH>
            <TH>Estado</TH>
            <TH>Asignado</TH>
          </TR>
        </THead>
        <TBody>
          {tickets.map((t) => (
            <TR key={t.id}>
              <TD>
                <div className="font-medium">{t.title}</div>
                <div className="text-xs text-[var(--muted)]">
                  {t.description}
                </div>
              </TD>
              <TD>{t.companies?.name}</TD>
              <TD>
                <Badge>{t.priority}</Badge>
              </TD>
              <TD>
                <Select
                  defaultValue={t.status}
                  onChange={async (e) => {
                    try {
                      await updateTicketStatus(t.id, e.target.value);
                      toast.success("Ticket actualizado");
                      router.refresh();
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Error",
                      );
                    }
                  }}
                >
                  <option value="open">open</option>
                  <option value="in_progress">in_progress</option>
                  <option value="resolved">resolved</option>
                  <option value="closed">closed</option>
                </Select>
              </TD>
              <TD>
                {t.profiles?.full_name || t.profiles?.email || "—"}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
