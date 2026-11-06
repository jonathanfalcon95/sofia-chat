import bcrypt from "bcryptjs";
import { execute, transaction } from "@/lib/db/sqlserver/connection";
import { isUuid, sql } from "@/lib/db/sqlserver/sql";
import {
  afterFailedLogin,
  DUMMY_BCRYPT_HASH,
  isLocked,
  normalizeEmail,
} from "./login-policy";

const BCRYPT_COST = 10;

type LoginResult =
  | { ok: true; userId: string; sessionVersion: number }
  | { ok: false; reason: "invalid" | "locked" };

export async function verifyLogin(emailInput: string, password: string): Promise<LoginResult> {
  const email = normalizeEmail(emailInput);
  const [user] = await execute(sql`
    SELECT id, password_hash, session_version, is_disabled, failed_login_count, locked_until
    FROM chatbase.auth_users WHERE email = ${email}`);

  // Runs for unknown users too, so the response time gives nothing away.
  const matches = await bcrypt.compare(password, (user?.password_hash as string) ?? DUMMY_BCRYPT_HASH);
  if (!user || user.is_disabled === true) return { ok: false, reason: "invalid" };
  if (isLocked(user.locked_until as string | null)) return { ok: false, reason: "locked" };

  if (!matches) {
    const next = afterFailedLogin(user.failed_login_count as number);
    await execute(sql`
      UPDATE chatbase.auth_users
      SET failed_login_count = ${next.failedCount}, locked_until = ${next.lockedUntil}
      WHERE id = ${user.id as string}`);
    return { ok: false, reason: next.lockedUntil ? "locked" : "invalid" };
  }

  await execute(sql`
    UPDATE chatbase.auth_users
    SET failed_login_count = 0, locked_until = NULL, last_sign_in_at = SYSUTCDATETIME()
    WHERE id = ${user.id as string}`);
  return {
    ok: true,
    userId: user.id as string,
    sessionVersion: user.session_version as number,
  };
}

/** Current session version, or null if the user can't hold a session any more. */
export async function activeSessionVersion(userId: string): Promise<number | null> {
  if (!isUuid(userId)) return null;
  const [user] = await execute(sql`
    SELECT session_version FROM chatbase.auth_users
    WHERE id = ${userId} AND is_disabled = 0`);
  return (user?.session_version as number | undefined) ?? null;
}

/** Also ends the user's other sessions. Returns the new version for the current one. */
export async function setPassword(userId: string, newPassword: string): Promise<number> {
  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  const [updated] = await execute(sql`
    UPDATE chatbase.auth_users
    SET password_hash = ${hash}, session_version = session_version + 1,
        password_changed_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME(),
        failed_login_count = 0, locked_until = NULL
    OUTPUT INSERTED.session_version
    WHERE id = ${userId}`);
  return updated.session_version as number;
}

export async function passwordMatches(userId: string, password: string) {
  const [user] = await execute(sql`
    SELECT password_hash FROM chatbase.auth_users WHERE id = ${userId}`);
  return Boolean(user && (await bcrypt.compare(password, user.password_hash as string)));
}

export type CreateUserResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

/** The user and profile are created together; this replaces the `handle_new_user` trigger. */
export async function createUser(input: {
  email: string;
  password: string;
  fullName: string;
}): Promise<CreateUserResult> {
  const email = normalizeEmail(input.email);
  const hash = await bcrypt.hash(input.password, BCRYPT_COST);
  try {
    const userId = await transaction(async (run) => {
      const [user] = await run(sql`
        INSERT INTO chatbase.auth_users (id, email, password_hash, email_confirmed_at)
        OUTPUT INSERTED.id
        VALUES (NEWID(), ${email}, ${hash}, SYSUTCDATETIME())`);
      await run(sql`
        INSERT INTO chatbase.profiles (id, email, full_name)
        VALUES (${user.id as string}, ${email}, ${input.fullName})`);
      return user.id as string;
    });
    return { ok: true, userId };
  } catch (err) {
    const number = (err as { number?: number }).number;
    if (number === 2627 || number === 2601) {
      return { ok: false, error: "Ya existe un usuario con ese correo" };
    }
    throw err;
  }
}
