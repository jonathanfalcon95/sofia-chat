import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { downloadWithFallback, uploadWithFallback } from "./chat-media-store.ts";

const SUPABASE = { data: "from-supabase", error: null };

describe("downloadWithFallback", () => {
  test("returns the blob without touching Supabase", async () => {
    const file = new Blob(["x"]);
    const result = await downloadWithFallback({
      fromBlob: async () => file,
      fromSupabase: async () => assert.fail("must not read Supabase"),
      onBlobError: () => assert.fail("no error expected"),
    });
    assert.deepEqual(result, { data: file, error: null });
  });

  test("falls back when the file was not copied yet, without reporting an error", async () => {
    const result = await downloadWithFallback({
      fromBlob: async () => null,
      fromSupabase: async () => SUPABASE,
      onBlobError: () => assert.fail("a missing blob is not an error"),
    });
    assert.equal(result, SUPABASE);
  });

  test("falls back and reports when Blob fails", async () => {
    const seen: unknown[] = [];
    const failure = new Error("blob down");
    const result = await downloadWithFallback({
      fromBlob: async () => {
        throw failure;
      },
      fromSupabase: async () => SUPABASE,
      onBlobError: (err) => seen.push(err),
    });
    assert.equal(result, SUPABASE);
    assert.deepEqual(seen, [failure]);
  });

  test("passes on Supabase's own not-found answer", async () => {
    const missing = { data: null, error: { message: "not found" } };
    const result = await downloadWithFallback({
      fromBlob: async () => null,
      fromSupabase: async () => missing,
      onBlobError: () => {},
    });
    assert.equal(result, missing);
  });
});

describe("uploadWithFallback", () => {
  test("a Blob success never writes to Supabase", async () => {
    const result = await uploadWithFallback({
      toBlob: async () => true,
      toSupabase: async () => assert.fail("must not write to Supabase"),
      onBlobError: () => assert.fail("no error expected"),
    });
    assert.deepEqual(result, { data: null, error: null });
  });

  test("a Blob failure still stores the file in Supabase", async () => {
    const seen: unknown[] = [];
    const failure = new Error("blob down");
    const result = await uploadWithFallback({
      toBlob: async () => {
        throw failure;
      },
      toSupabase: async () => SUPABASE,
      onBlobError: (err) => seen.push(err),
    });
    assert.equal(result, SUPABASE);
    assert.deepEqual(seen, [failure]);
  });

  test("a failure in both reaches the caller", async () => {
    const failed = { data: null, error: { message: "both down" } };
    const result = await uploadWithFallback({
      toBlob: async () => {
        throw new Error("blob down");
      },
      toSupabase: async () => failed,
      onBlobError: () => {},
    });
    assert.equal(result, failed);
  });
});
