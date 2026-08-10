"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import { toast } from "sonner";
import {
  updateErrorLogStatus,
  type ErrorLogStatus,
} from "@/app/actions/error-logs";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type ErrorLogRow = {
  id: string;
  created_at: string;
  updated_at: string;
  level: string;
  status: string;
  source: string;
  message: string;
  error_name: string | null;
  error_code: string | null;
  http_status: number | null;
  stack: string | null;
  context: Record<string, unknown>;
  company_id: string | null;
  user_id: string | null;
  request_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  company_name: string | null;
  actor: { full_name: string | null; email: string } | null;
  resolver: { full_name: string | null; email: string } | null;
};

const STATUSES: ErrorLogStatus[] = [
  "open",
  "acknowledged",
  "resolved",
  "ignored",
];

const STATUS_LABELS: Record<ErrorLogStatus, string> = {
  open: "Abierto",
  acknowledged: "Reconocido",
  resolved: "Resuelto",
  ignored: "Ignorado",
};

const LEVELS = ["error", "warn", "fatal"] as const;

const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  error: "Error",
  warn: "Warn",
  fatal: "Fatal",
};

function levelBadgeClass(level: string) {
  if (level === "fatal")
    return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
  if (level === "warn")
    return "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300";
  return "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300";
}

function statusBadgeClass(status: string) {
  if (status === "resolved")
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "ignored")
    return "border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)]";
  if (status === "acknowledged")
    return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]";
}

export function ErrorLogsManager({
  logs,
  companies,
}: {
  logs: ErrorLogRow[];
  companies: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ErrorLogRow | null>(null);
  const [note, setNote] = useState("");

  const sources = useMemo(() => {
    return Array.from(new Set(logs.map((l) => l.source))).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((row) => {
      if (companyFilter === "none" && row.company_id) return false;
      if (
        companyFilter !== "all" &&
        companyFilter !== "none" &&
        row.company_id !== companyFilter
      ) {
        return false;
      }
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (levelFilter !== "all" && row.level !== levelFilter) return false;
      if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        row.message.toLowerCase().includes(q) ||
        row.source.toLowerCase().includes(q) ||
        (row.error_code?.toLowerCase().includes(q) ?? false) ||
        (row.error_name?.toLowerCase().includes(q) ?? false) ||
        (row.request_id?.toLowerCase().includes(q) ?? false) ||
        (row.company_name?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [
    logs,
    companyFilter,
    statusFilter,
    levelFilter,
    sourceFilter,
    query,
  ]);

  function openDetail(row: ErrorLogRow) {
    setSelected(row);
    setNote(row.resolution_note ?? "");
  }

  function setStatus(status: ErrorLogStatus) {
    if (!selected) return;
    startTransition(async () => {
      try {
        await updateErrorLogStatus({
          id: selected.id,
          status,
          resolutionNote: note,
        });
        toast.success(`Marcado como ${STATUS_LABELS[status].toLowerCase()}`);
        setSelected(null);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al actualizar");
      }
    });
  }

  return (
    <div>
      <PageHeader
        title="Log de errores"
        description="Incidencias del sistema. Filtra por empresa y triaja el estado."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          className="w-auto min-w-[180px]"
          aria-label="Filtrar por empresa"
        >
          <option value="all">Todas las empresas</option>
          <option value="none">Sin empresa</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-auto min-w-[150px]"
          aria-label="Filtrar por estado"
        >
          <option value="all">Todos los estados</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="w-auto min-w-[120px]"
          aria-label="Filtrar por nivel"
        >
          <option value="all">Todos los niveles</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABELS[l]}
            </option>
          ))}
        </Select>
        <Select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="w-auto min-w-[180px]"
          aria-label="Filtrar por origen"
        >
          <option value="all">Todos los orígenes</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar mensaje, código…"
          className="max-w-xs"
          aria-label="Buscar en logs"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
        <Table>
          <THead>
            <TR>
              <TH>Cuándo</TH>
              <TH>Nivel</TH>
              <TH>Estado</TH>
              <TH>Origen</TH>
              <TH>Mensaje</TH>
              <TH>Empresa</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.length === 0 ? (
              <TR>
                <TD colSpan={6} className="py-8 text-center text-[var(--muted)]">
                  No hay incidencias con estos filtros.
                </TD>
              </TR>
            ) : (
              filtered.map((row) => (
                <TR
                  key={row.id}
                  className="cursor-pointer hover:bg-[var(--surface-2)]"
                  onClick={() => openDetail(row)}
                >
                  <TD className="whitespace-nowrap text-xs text-[var(--muted)]">
                    {formatDistanceToNow(new Date(row.created_at), {
                      addSuffix: true,
                      locale: es,
                    })}
                  </TD>
                  <TD>
                    <Badge className={cn(levelBadgeClass(row.level))}>
                      {LEVEL_LABELS[row.level as (typeof LEVELS)[number]] ??
                        row.level}
                    </Badge>
                  </TD>
                  <TD>
                    <Badge className={cn(statusBadgeClass(row.status))}>
                      {STATUS_LABELS[row.status as ErrorLogStatus] ??
                        row.status}
                    </Badge>
                  </TD>
                  <TD className="max-w-[160px] truncate font-mono text-xs">
                    {row.source}
                  </TD>
                  <TD className="max-w-[320px] truncate">{row.message}</TD>
                  <TD className="whitespace-nowrap text-sm">
                    {row.company_name ?? (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle className="pr-8">{selected.message}</DialogTitle>
                <DialogDescription className="font-mono text-xs">
                  {selected.source}
                  {selected.error_code ? ` · ${selected.error_code}` : ""}
                  {selected.http_status ? ` · HTTP ${selected.http_status}` : ""}
                </DialogDescription>
              </DialogHeader>

              <div className="mt-3 flex flex-wrap gap-2">
                <Badge className={cn(levelBadgeClass(selected.level))}>
                  {LEVEL_LABELS[selected.level as (typeof LEVELS)[number]] ??
                    selected.level}
                </Badge>
                <Badge className={cn(statusBadgeClass(selected.status))}>
                  {STATUS_LABELS[selected.status as ErrorLogStatus] ??
                    selected.status}
                </Badge>
              </div>

              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-[var(--muted)]">Fecha</dt>
                  <dd>{new Date(selected.created_at).toLocaleString("es")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Empresa</dt>
                  <dd>{selected.company_name ?? "Sin empresa"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Usuario</dt>
                  <dd>
                    {selected.actor
                      ? selected.actor.full_name || selected.actor.email
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Request ID</dt>
                  <dd className="font-mono text-xs">
                    {selected.request_id ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Error</dt>
                  <dd className="font-mono text-xs">
                    {selected.error_name ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--muted)]">Resuelto por</dt>
                  <dd>
                    {selected.resolver
                      ? selected.resolver.full_name || selected.resolver.email
                      : "—"}
                  </dd>
                </div>
              </dl>

              {selected.stack ? (
                <div className="mt-4 space-y-1.5">
                  <Label>Stack</Label>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs leading-relaxed">
                    {selected.stack}
                  </pre>
                </div>
              ) : null}

              <div className="mt-4 space-y-1.5">
                <Label>Contexto</Label>
                <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 text-xs leading-relaxed">
                  {JSON.stringify(selected.context ?? {}, null, 2)}
                </pre>
              </div>

              <div className="mt-4 space-y-1.5">
                <Label htmlFor="resolution_note">Nota de resolución</Label>
                <Textarea
                  id="resolution_note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder="Qué se hizo / por qué se ignora…"
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setStatus("acknowledged")}
                >
                  Reconocer
                </Button>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => setStatus("resolved")}
                >
                  Resolver
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setStatus("ignored")}
                >
                  Ignorar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setStatus("open")}
                >
                  Reabrir
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
