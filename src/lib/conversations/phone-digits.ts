/** Digits-only phone for lookup. Accepts +, spaces, and percent-encoding. */
export function normalizePhoneDigits(phone: string): string {
  let value = phone.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  return value.replace(/\D/g, "");
}
