import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeNextPath, loginUrlWithNext } from "./safe-next-path.ts";

const GUID = "08be5fd3-a186-4141-83c8-4a9133de25f4";
const DEEP = `/c/${GUID}/584266330794`;
const THREAD = "/conversations/e461b6c5-7619-453d-9784-94fc9af215bb";

test("isSafeNextPath accepts chat deep links and conversation threads", () => {
  assert.equal(isSafeNextPath(DEEP), true);
  assert.equal(isSafeNextPath("/conversations"), true);
  assert.equal(isSafeNextPath(THREAD), true);
  assert.equal(isSafeNextPath("/conversations/"), true);
});

test("isSafeNextPath rejects open redirects and off-allowlist paths", () => {
  assert.equal(isSafeNextPath(null), false);
  assert.equal(isSafeNextPath(""), false);
  assert.equal(isSafeNextPath("//evil.example"), false);
  assert.equal(isSafeNextPath("https://evil.example"), false);
  assert.equal(isSafeNextPath("/\\evil"), false);
  assert.equal(isSafeNextPath("/dashboard"), false);
  assert.equal(isSafeNextPath("/conversations-evil"), false);
  assert.equal(isSafeNextPath("/c"), false);
  assert.equal(isSafeNextPath("/%2F%2Fevil.example"), false);
});

test("loginUrlWithNext encodes allowed destinations", () => {
  assert.equal(
    loginUrlWithNext(DEEP),
    `/login?next=${encodeURIComponent(DEEP)}`,
  );
  assert.equal(
    loginUrlWithNext(THREAD),
    `/login?next=${encodeURIComponent(THREAD)}`,
  );
  assert.equal(loginUrlWithNext("/dashboard"), "/login");
  assert.equal(loginUrlWithNext(""), "/login");
});
