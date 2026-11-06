/** Palette with enough contrast for white initials. */
const AVATAR_COLORS = [
  "#0f766e",
  "#0369a1",
  "#047857",
  "#b45309",
  "#b91c1c",
  "#4338ca",
  "#0e7490",
  "#c2410c",
] as const;

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Up to two initials, or null when the name has no letters (e.g. a phone). */
export function avatarInitials(name: string | null | undefined): string | null {
  const words = (name ?? "").match(/\p{L}[\p{L}\p{M}'’-]*/gu);
  if (!words) return null;
  const pick = words.length > 1 ? [words[0], words[1]] : [words[0]];
  return pick
    .map((word) => Array.from(word)[0])
    .join("")
    .toLocaleUpperCase("es");
}
