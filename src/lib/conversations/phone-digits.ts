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

/** Opens the contact chat in the WhatsApp app/web. */
export function whatsappDeepLink(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  return `https://wa.me/${digits}`;
}
