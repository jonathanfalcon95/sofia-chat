import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicOrigin, toPublicUrl } from "./server-url.ts";

test("toPublicUrl uses public host header when valid", () => {
  const req = new Request("https://0.0.0.0:21665/c/xyz/123", {
    headers: {
      host: "agentesofiachat.site",
      "x-forwarded-proto": "https",
    },
  });

  const url = toPublicUrl("/conversations/3f37ced6-849e-4dbe-af2c-bb6f3a5318cc", req);
  assert.equal(
    url.href,
    "https://agentesofiachat.site/conversations/3f37ced6-849e-4dbe-af2c-bb6f3a5318cc",
  );
});

test("toPublicUrl respects x-forwarded-host over internal host", () => {
  const req = new Request("http://0.0.0.0:21665/c/xyz/123", {
    headers: {
      host: "0.0.0.0:21665",
      "x-forwarded-host": "www.agentesofiachat.site",
      "x-forwarded-proto": "https",
    },
  });

  const url = toPublicUrl("/login", req);
  assert.equal(url.href, "https://www.agentesofiachat.site/login");
});

test("toPublicUrl ignores 0.0.0.0 host in production and falls back to NEXT_PUBLIC_APP_URL", () => {
  const prevEnv = process.env.NODE_ENV;
  const prevUrl = process.env.NEXT_PUBLIC_APP_URL;
  try {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://agentesofiachat.site";

    const req = new Request("https://0.0.0.0:21665/c/xyz/123", {
      headers: {
        host: "0.0.0.0:21665",
      },
    });

    const url = toPublicUrl("/conversations/123", req);
    assert.equal(url.href, "https://agentesofiachat.site/conversations/123");
  } finally {
    process.env.NODE_ENV = prevEnv;
    process.env.NEXT_PUBLIC_APP_URL = prevUrl;
  }
});
