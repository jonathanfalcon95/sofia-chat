export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
  urgent: "Urgente",
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Abierto",
  in_progress: "En progreso",
  resolved: "Resuelto",
  closed: "Cerrado",
};

export function isTicketPriority(value: string): value is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(value);
}

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export function priorityBadgeClass(priority: string): string {
  switch (priority) {
    case "urgent":
      return "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300";
    case "high":
      return "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300";
    case "low":
      return "border-[var(--line)] bg-[var(--surface-2)] text-[var(--muted)]";
    default:
      return "border-[var(--line)] bg-[var(--accent-soft)] text-[var(--accent)]";
  }
}
