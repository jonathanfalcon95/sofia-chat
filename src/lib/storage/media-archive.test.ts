import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveBatch,
  archivePath,
  chatMediaRef,
  type ArchiveDeps,
  type PendingMedia,
} from "./media-archive.ts";

function item(overrides: Partial<PendingMedia> = {}): PendingMedia {
  return {
    id: "m1",
    companyId: "c1",
    conversationId: "v1",
    inboxId: "i1",
    type: "image",
    mediaUrl: "https://api.ycloud.com/file/1",
    mime: "image/jpeg",
    filename: "foto.jpg",
    ...overrides,
  };
}

function harness(items: PendingMedia[], overrides: Partial<ArchiveDeps> = {}) {
  const puts: { path: string; bytes: Buffer; contentType: string }[] = [];
  const refs: { id: string; current: string; next: string }[] = [];
  const keyLookups: string[] = [];
  const listCalls: string[][] = [];
  const deps: ArchiveDeps = {
    listPending: async (limit, exclude) => {
      listCalls.push(exclude);
      return items.slice(0, limit);
    },
    apiKeyFor: async (inbox) => {
      keyLookups.push(inbox);
      return `key-${inbox}`;
    },
    download: async () => new Response(new Uint8Array([1, 2, 3])),
    put: async (path, bytes, contentType) => {
      puts.push({ path, bytes, contentType });
    },
    setMediaUrl: async (id, current, next) => {
      refs.push({ id, current, next });
    },
    maxBytes: () => 1000,
    ...overrides,
  };
  return { deps, puts, refs, keyLookups, listCalls };
}

const quiet = <T>(work: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  return work().finally(() => {
    console.error = original;
  });
};

describe("archiveBatch", () => {
  test("stores the file, then points the message at it", async () => {
    const h = harness([item()]);
    const result = await archiveBatch(h.deps, new Set(), 10);
    assert.deepEqual(result, { archived: 1, gone: 0, failed: 0, stoppedEarly: false });
    assert.equal(h.puts[0]!.path, "ycloud/c1/v1/m1-foto.jpg");
    assert.deepEqual([...h.puts[0]!.bytes], [1, 2, 3]);
    assert.equal(h.puts[0]!.contentType, "image/jpeg");
    assert.deepEqual(h.refs, [
      {
        id: "m1",
        current: "https://api.ycloud.com/file/1",
        next: "storage:chat-media/ycloud/c1/v1/m1-foto.jpg",
      },
    ]);
  });

  test("an expired link is never retried and does not count as a failure", async () => {
    const h = harness([item()], { download: async () => new Response(null, { status: 404 }) });
    const gaveUp = new Set<string>();
    const result = await archiveBatch(h.deps, gaveUp, 10);
    assert.deepEqual(result, { archived: 0, gone: 1, failed: 0, stoppedEarly: false });
    assert.deepEqual([...gaveUp], ["m1"]);
    assert.equal(h.puts.length, 0);
    assert.equal(h.refs.length, 0);

    await archiveBatch(h.deps, gaveUp, 10);
    assert.deepEqual(h.listCalls[1], ["m1"]);
  });

  test("a temporary failure leaves the message as it was, to retry later", async () => {
    const h = harness([item()], { download: async () => new Response(null, { status: 500 }) });
    const gaveUp = new Set<string>();
    const result = await quiet(() => archiveBatch(h.deps, gaveUp, 10));
    assert.equal(result.failed, 1);
    assert.equal(gaveUp.size, 0);
    assert.equal(h.refs.length, 0);
  });

  test("the message keeps its link if the upload fails", async () => {
    const h = harness([item()], {
      put: async () => {
        throw new Error("blob down");
      },
    });
    const gaveUp = new Set<string>();
    const result = await quiet(() => archiveBatch(h.deps, gaveUp, 10));
    assert.equal(result.failed, 1);
    assert.equal(h.refs.length, 0);
    assert.equal(gaveUp.size, 0);
  });

  test("three failures in a row end the pass", async () => {
    const items = ["a", "b", "c", "d", "e"].map((id) => item({ id }));
    let downloads = 0;
    const h = harness(items, {
      download: async () => {
        downloads += 1;
        return new Response(null, { status: 503 });
      },
    });
    const result = await quiet(() => archiveBatch(h.deps, new Set(), 10));
    assert.equal(downloads, 3);
    assert.equal(result.failed, 3);
    assert.equal(result.stoppedEarly, true);
  });

  test("a success resets the count of failures", async () => {
    const statuses = [500, 500, 200, 500, 500, 200];
    const h = harness(statuses.map((_, i) => item({ id: `m${i}` })), {
      download: async () => {
        const status = statuses.shift()!;
        return new Response(status === 200 ? new Uint8Array([1]) : null, { status });
      },
    });
    const result = await quiet(() => archiveBatch(h.deps, new Set(), 10));
    assert.equal(result.archived, 2);
    assert.equal(result.failed, 4);
    assert.equal(result.stoppedEarly, false);
  });

  test("a file over the limit is left alone for good", async () => {
    const h = harness([item()], { maxBytes: () => 2 });
    const gaveUp = new Set<string>();
    const result = await archiveBatch(h.deps, gaveUp, 10);
    assert.equal(result.gone, 1);
    assert.equal(h.puts.length, 0);
    assert.deepEqual([...gaveUp], ["m1"]);
  });

  test("an empty download is not stored", async () => {
    const h = harness([item()], { download: async () => new Response(new Uint8Array()) });
    const result = await quiet(() => archiveBatch(h.deps, new Set(), 10));
    assert.equal(result.failed, 1);
    assert.equal(h.puts.length, 0);
  });

  test("a message with no inbox has no key to use", async () => {
    const h = harness([item({ inboxId: null })]);
    const gaveUp = new Set<string>();
    const result = await archiveBatch(h.deps, gaveUp, 10);
    assert.equal(result.gone, 1);
    assert.deepEqual([...gaveUp], ["m1"]);
  });

  test("looks up each inbox's key once per pass", async () => {
    const h = harness([item({ id: "a" }), item({ id: "b" }), item({ id: "c", inboxId: "i2" })]);
    await archiveBatch(h.deps, new Set(), 10);
    assert.deepEqual(h.keyLookups, ["i1", "i2"]);
  });

  test("uses the type the download reports when the message has none", async () => {
    const h = harness([item({ mime: null })], {
      download: async () =>
        new Response(new Uint8Array([1]), { headers: { "content-type": "audio/ogg" } }),
    });
    await archiveBatch(h.deps, new Set(), 10);
    assert.equal(h.puts[0]!.contentType, "audio/ogg");
  });
});

describe("archivePath", () => {
  test("repeats for the same message, so a second run finds the same blob", () => {
    assert.equal(archivePath(item()), archivePath(item()));
  });

  test("cleans names that could change the path", () => {
    const path = archivePath(item({ filename: "../../otra empresa/ñandú.pdf" }));
    assert.equal(path, "ycloud/c1/v1/m1-.._.._otra_empresa_and_.pdf");
    assert.equal(path.split("/").length, 4);
  });

  test("works without a file name", () => {
    assert.equal(archivePath(item({ filename: null })), "ycloud/c1/v1/m1-file");
  });

  test("keeps long names to a safe size and keeps the extension", () => {
    const path = archivePath(item({ filename: `${"a".repeat(500)}.pdf` }));
    assert.ok(path.length < 200);
    assert.ok(path.endsWith(".pdf"));
  });
});

test("chatMediaRef uses the format the media route reads", () => {
  assert.equal(chatMediaRef("a/b.jpg"), "storage:chat-media/a/b.jpg");
});
