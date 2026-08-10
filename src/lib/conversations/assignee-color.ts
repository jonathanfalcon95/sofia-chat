/** Stable palette for assignee badges (no purple-on-white defaults). */
const ASSIGNEE_COLORS = [
  "#0d9488", // teal
  "#0284c7", // sky
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#4f46e5", // indigo
  "#0891b2", // cyan
  "#c2410c", // orange
] as const;

export function assigneeColor(assigneeId: string): string {
  let hash = 0;
  for (let i = 0; i < assigneeId.length; i++) {
    hash = (hash * 31 + assigneeId.charCodeAt(i)) >>> 0;
  }
  return ASSIGNEE_COLORS[hash % ASSIGNEE_COLORS.length];
}
