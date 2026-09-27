import type { MessageRow } from "./types";

export function getCalendarDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDayChip(date: Date, referenceDate = new Date()): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const targetDay = startOfDay(date);
  const refDay = startOfDay(referenceDate);
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((refDay - targetDay) / msPerDay);

  if (diffDays === 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  if (diffDays > 1 && diffDays < 7) {
    const weekday = new Intl.DateTimeFormat("es", { weekday: "long" }).format(
      date,
    );
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }

  const isCurrentYear = date.getFullYear() === referenceDate.getFullYear();
  if (isCurrentYear) {
    const formatted = new Intl.DateTimeFormat("es", {
      day: "numeric",
      month: "long",
    }).format(date);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  const formatted = new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

export type DayGroup = {
  dayKey: string;
  dayLabel: string;
  messages: MessageRow[];
};

export function groupMessagesByDay(
  messages: MessageRow[],
  referenceDate = new Date(),
): DayGroup[] {
  const groups: DayGroup[] = [];
  let currentGroup: DayGroup | null = null;

  for (const m of messages) {
    const date = new Date(m.created_at);
    const dayKey = getCalendarDayKey(date);

    if (!currentGroup || currentGroup.dayKey !== dayKey) {
      currentGroup = {
        dayKey,
        dayLabel: formatDayChip(date, referenceDate),
        messages: [m],
      };
      groups.push(currentGroup);
    } else {
      currentGroup.messages.push(m);
    }
  }

  return groups;
}
