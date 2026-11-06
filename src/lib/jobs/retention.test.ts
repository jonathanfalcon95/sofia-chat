import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deleteInBatches, retentionDays } from "./retention.ts";

describe("retentionDays", () => {
  test("defaults to 30 days", () => {
    assert.equal(retentionDays(undefined), 30);
    assert.equal(retentionDays(""), 30);
    assert.equal(retentionDays("abc"), 30);
    assert.equal(retentionDays("1.5"), 30);
  });

  test("uses the setting", () => {
    assert.equal(retentionDays("90"), 90);
  });

  test("a mistaken value cannot delete events still needed to catch duplicates", () => {
    assert.equal(retentionDays("0"), 7);
    assert.equal(retentionDays("-5"), 7);
    assert.equal(retentionDays("1"), 7);
  });
});

describe("deleteInBatches", () => {
  const pauseCounter = () => {
    const state = { pauses: 0, pause: async () => void (state.pauses += 1) };
    return state;
  };

  test("stops at the first batch that is not full", async () => {
    const answers = [100, 100, 40];
    const sizes: number[] = [];
    const p = pauseCounter();
    const total = await deleteInBatches({
      deleteBatch: async (size) => {
        sizes.push(size);
        return answers.shift()!;
      },
      batchSize: 100,
      maxBatches: 10,
      pause: p.pause,
    });
    assert.equal(total, 240);
    assert.deepEqual(sizes, [100, 100, 100]);
    assert.equal(p.pauses, 2);
  });

  test("never does more than the limit in one run", async () => {
    let calls = 0;
    const total = await deleteInBatches({
      deleteBatch: async (size) => {
        calls += 1;
        return size;
      },
      batchSize: 100,
      maxBatches: 3,
      pause: async () => {},
    });
    assert.equal(calls, 3);
    assert.equal(total, 300);
  });

  test("nothing to delete takes one query and no pause", async () => {
    const p = pauseCounter();
    const total = await deleteInBatches({
      deleteBatch: async () => 0,
      batchSize: 100,
      maxBatches: 10,
      pause: p.pause,
    });
    assert.equal(total, 0);
    assert.equal(p.pauses, 0);
  });

  test("a failure reaches the caller", async () => {
    await assert.rejects(
      deleteInBatches({
        deleteBatch: async () => {
          throw new Error("db down");
        },
        batchSize: 100,
        maxBatches: 10,
        pause: async () => {},
      }),
      /db down/,
    );
  });
});
