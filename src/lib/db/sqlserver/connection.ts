import { Pool } from "tarn";
import { Connection, Request, TYPES } from "tedious";
import type { SqlFragment, SqlValue } from "./sql";

export type Row = Record<string, unknown>;

/** jsonb in Postgres, nvarchar(max) here. Callers expect parsed values. */
const JSON_COLUMNS = new Set([
  "metadata",
  "template_components",
  "raw_payload",
  "reactions",
  "context",
  "payload",
]);

/** Throttling, failover and deadlock: safe to retry when nothing else was in the transaction. */
const TRANSIENT = new Set([1205, 4060, 10928, 10929, 40197, 40501, 40613, 49918, 49919, 49920]);

function config() {
  const server = process.env.SQL_SERVER;
  const database = process.env.SQL_DB;
  const userName = process.env.SQL_USER;
  const password = process.env.SQL_PASSWORD;
  if (!server || !database || !userName || !password) {
    throw new Error("Faltan SQL_SERVER, SQL_DB, SQL_USER o SQL_PASSWORD");
  }
  return {
    server,
    authentication: { type: "default" as const, options: { userName, password } },
    options: {
      database,
      encrypt: true,
      lowerCaseGuids: true,
      useUTC: true,
      connectTimeout: 15_000,
      requestTimeout: 30_000,
      rowCollectionOnRequestCompletion: false,
    },
  };
}

function openConnection(): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = new Connection(config());
    connection.once("connect", (err) => (err ? reject(err) : resolve(connection)));
    // An idle connection that dies must not take the process down.
    connection.on("error", () => {});
    connection.connect();
  });
}

const globalPool = globalThis as unknown as { __chatbaseSqlPool?: Pool<Connection> };

function pool(): Pool<Connection> {
  globalPool.__chatbaseSqlPool ??= new Pool<Connection>({
    create: openConnection,
    destroy: (connection) => connection.close(),
    validate: (connection) =>
      (connection as unknown as { state?: { name?: string } }).state?.name === "LoggedIn",
    min: 0,
    max: 10,
    acquireTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
  });
  return globalPool.__chatbaseSqlPool;
}

function parameterType(value: SqlValue) {
  if (typeof value === "boolean") return TYPES.Bit;
  if (typeof value === "number") return Number.isInteger(value) ? TYPES.BigInt : TYPES.Float;
  return TYPES.NVarChar;
}

function normalize(column: string, value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && JSON_COLUMNS.has(column)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function runOn(connection: Connection, statement: SqlFragment): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const rows: Row[] = [];
    const request = new Request(statement.text, (err) => (err ? reject(err) : resolve(rows)));
    statement.params.forEach((value, i) => {
      const type = parameterType(value);
      const options =
        type === TYPES.NVarChar && typeof value === "string" && value.length > 4000
          ? { length: Infinity }
          : type === TYPES.NVarChar
            ? { length: 4000 }
            : undefined;
      request.addParameter(`p${i}`, type, value, options);
    });
    request.on("row", (columns) => {
      const row: Row = {};
      for (const column of columns) {
        row[column.metadata.colName] = normalize(column.metadata.colName, column.value);
      }
      rows.push(row);
    });
    connection.execSql(request);
  });
}

/**
 * Session-level statements. execSql wraps its text in sp_executesql, a scope of its own: it would
 * raise error 266 on BEGIN TRANSACTION and undo SET XACT_ABORT on return.
 */
function runBatch(connection: Connection, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.execSqlBatch(new Request(text, (err) => (err ? reject(err) : resolve())));
  });
}

function isTransient(err: unknown) {
  const e = err as { number?: number; code?: string };
  return (
    (e.number !== undefined && TRANSIENT.has(e.number)) ||
    e.code === "ESOCKET" ||
    e.code === "ETIMEOUT"
  );
}

/** One statement on a pooled connection, with one retry on transient failures. */
export async function execute(statement: SqlFragment): Promise<Row[]> {
  for (let attempt = 0; ; attempt++) {
    const connection = await pool().acquire().promise;
    try {
      return await runOn(connection, statement);
    } catch (err) {
      if (attempt >= 1 || !isTransient(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      pool().release(connection);
    }
  }
}

export type TransactionRunner = (statement: SqlFragment) => Promise<Row[]>;

/** Everything in `work` commits or rolls back together. Deadlocks retry the whole unit. */
export async function transaction<T>(work: (run: TransactionRunner) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const connection = await pool().acquire().promise;
    try {
      await runBatch(connection, "SET XACT_ABORT ON; BEGIN TRANSACTION");
      try {
        const result = await work((statement) => runOn(connection, statement));
        await runBatch(connection, "COMMIT TRANSACTION");
        return result;
      } catch (err) {
        await runBatch(connection, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").catch(() => {});
        throw err;
      }
    } catch (err) {
      if (attempt >= 2 || !isTransient(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    } finally {
      pool().release(connection);
    }
  }
}
