import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret, secretLast4 } from "./secret.ts";

process.env.CREDENTIALS_ENCRYPTION_KEY = "a".repeat(64);

test("encrypt/decrypt roundtrip", () => {
  const plain = "whsec_abc123";
  const enc = encryptSecret(plain);
  assert.match(enc, /^v1:/);
  assert.equal(decryptSecret(enc), plain);
  assert.notEqual(enc, encryptSecret(plain));
});

test("secretLast4", () => {
  assert.equal(secretLast4("c17c9ed2cccfa5851776c8ff2f0a4c44"), "4c44");
});
