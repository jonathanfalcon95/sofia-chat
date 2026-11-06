import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "chatbase_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** A token with less than this left gets replaced, so active users are never signed out. */
const RENEW_BELOW_SECONDS = SESSION_MAX_AGE_SECONDS / 2;

export type SessionClaims = {
  userId: string;
  sessionVersion: number;
  /** Seconds until expiry. */
  expiresIn: number;
};

function secretKey() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET debe tener al menos 32 caracteres");
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: string, sessionVersion: number) {
  return new SignJWT({ sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/** Null for anything missing, tampered with or expired. */
export async function readSessionToken(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.sv !== "number" || !payload.exp) return null;
    return {
      userId: payload.sub,
      sessionVersion: payload.sv,
      expiresIn: payload.exp - Math.floor(Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

export function shouldRenewSession(claims: SessionClaims) {
  return claims.expiresIn < RENEW_BELOW_SECONDS;
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_MAX_AGE_SECONDS,
} as const;
