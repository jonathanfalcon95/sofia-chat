export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt only reads the first 72 bytes, so longer passwords would be silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Verified against when the email is unknown, so timing doesn't reveal which accounts exist.
 * It is the hash of a discarded random value.
 */
export const DUMMY_BCRYPT_HASH =
  "$2a$10$tWi59AGWXblaU/KPfuwgZOCv1l6n.nFfJCGC4.mMXTo8WHoZzBgBi";

export function isLocked(lockedUntil: string | null | undefined, now = new Date()) {
  return Boolean(lockedUntil && new Date(lockedUntil).getTime() > now.getTime());
}

/** What to store after a wrong password. */
export function afterFailedLogin(failedCount: number, now = new Date()) {
  const next = failedCount + 1;
  return {
    failedCount: next >= MAX_FAILED_LOGINS ? 0 : next,
    lockedUntil:
      next >= MAX_FAILED_LOGINS
        ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString()
        : null,
  };
}

/** Null when acceptable, otherwise the message for the user. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return `La contraseña no puede superar ${MAX_PASSWORD_BYTES} bytes`;
  }
  return null;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}
