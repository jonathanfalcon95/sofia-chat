import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { transaction } from "./connection.ts";

type FakeRequest = { sqlTextOrProcedure: string; callback: (err?: Error | null) => void };

const holder = globalThis as unknown as { __chatbaseSqlPool?: unknown };

/** A pooled connection that records which entry point each statement used. */
function fakePool() {
  const calls: Array<{ via: "batch" | "rpc"; text: string }> = [];
  const connection = {
    execSqlBatch(request: FakeRequest) {
      calls.push({ via: "batch", text: request.sqlTextOrProcedure });
      request.callback(null);
    },
    execSql(request: FakeRequest) {
      calls.push({ via: "rpc", text: request.sqlTextOrProcedure });
      request.callback(null);
    },
  };
  holder.__chatbaseSqlPool = {
    acquire: () => ({ promise: Promise.resolve(connection) }),
    release: () => {},
  };
  return calls;
}

afterEach(() => {
  delete holder.__chatbaseSqlPool;
});

test("transaction control stays out of sp_executesql, which raises error 266 on BEGIN", async () => {
  const calls = fakePool();
  await transaction((run) => run({ text: "SELECT 1", params: [] }));
  assert.deepEqual(calls, [
    { via: "batch", text: "SET XACT_ABORT ON; BEGIN TRANSACTION" },
    { via: "rpc", text: "SELECT 1" },
    { via: "batch", text: "COMMIT TRANSACTION" },
  ]);
});

test("a failure rolls back, also through a batch", async () => {
  const calls = fakePool();
  await assert.rejects(
    transaction(async () => {
      throw new Error("boom");
    }),
    { message: "boom" },
  );
  assert.deepEqual(calls, [
    { via: "batch", text: "SET XACT_ABORT ON; BEGIN TRANSACTION" },
    { via: "batch", text: "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION" },
  ]);
});
