import { before, test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  createSessionToken,
  readSessionToken,
  shouldRenewSession,
  SESSION_MAX_AGE_SECONDS,
} from "./session-token.ts";

const SECRET = "secreto-de-prueba-de-al-menos-32-caracteres";
const USER = "abcdef00-1111-4222-8333-444455556666";

before(() => {
  process.env.AUTH_SESSION_SECRET = SECRET;
});

test("a token round-trips the user and session version", async () => {
  const claims = await readSessionToken(await createSessionToken(USER, 3));
  assert.equal(claims?.userId, USER);
  assert.equal(claims?.sessionVersion, 3);
  assert.equal(shouldRenewSession(claims!), false);
});

test("missing, garbage and tampered tokens read as no session", async () => {
  assert.equal(await readSessionToken(undefined), null);
  assert.equal(await readSessionToken("abc"), null);
  const token = await createSessionToken(USER, 1);
  const [head, , sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "otro", sv: 1, exp: 9999999999 })).toString("base64url");
  assert.equal(await readSessionToken(`${head}.${forged}.${sig}`), null);
});

test("a token signed with another secret is rejected", async () => {
  const other = await new SignJWT({ sv: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("otro-secreto-distinto-de-al-menos-32-caracteres"));
  assert.equal(await readSessionToken(other), null);
});

test("an unsigned token is rejected", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const none = `${b64({ alg: "none" })}.${b64({ sub: USER, sv: 1, exp: 9999999999 })}.`;
  assert.equal(await readSessionToken(none), null);
});

test("an expired token is rejected", async () => {
  const expired = await new SignJWT({ sv: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await readSessionToken(expired), null);
});

test("a token past half its life gets renewed", () => {
  assert.equal(
    shouldRenewSession({ userId: USER, sessionVersion: 1, expiresIn: SESSION_MAX_AGE_SECONDS / 2 - 1 }),
    true,
  );
});

test("a short secret refuses to sign rather than sign weakly", async () => {
  process.env.AUTH_SESSION_SECRET = "corto";
  await assert.rejects(() => createSessionToken(USER, 1), /32 caracteres/);
  process.env.AUTH_SESSION_SECRET = SECRET;
});
