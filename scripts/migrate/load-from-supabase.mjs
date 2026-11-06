// Copies chatbase from Supabase to the chatbase schema on Azure SQL.
//
//   node scripts/migrate/load-from-supabase.mjs preflight
//   node scripts/migrate/load-from-supabase.mjs apply-ddl --confirm <database>
//   node scripts/migrate/load-from-supabase.mjs load --confirm <database> [--months 2]
//   node scripts/migrate/load-from-supabase.mjs wipe --confirm <database>
//   node scripts/migrate/load-from-supabase.mjs apply-file --file 00x_nombre.sql --confirm <database>
//   node scripts/migrate/load-from-supabase.mjs grant-app --confirm <database>
//
// Reads DATABASE_URL (Postgres connection), SQL_SERVER, SQL_DB and AZ_SUBSCRIPTION from the
// environment and signs in to SQL with the az CLI token. Supabase is only ever read, inside one
// REPEATABLE READ snapshot. Row values are never logged: auth_users holds password hashes, so its
// errors report only the error number.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Connection, Request, TYPES } from "tedious";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta ${name}`);
    process.exit(2);
  }
  return value;
};
const SUBSCRIPTION = required("AZ_SUBSCRIPTION");
const SERVER = required("SQL_SERVER");
const DATABASE = required("SQL_DB");
const BATCH = 1000;
// Pause between batches while the shared database is above this percentage.
const THROTTLE_PERCENT = 70;

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const guid = { type: TYPES.UniqueIdentifier };
const bit = { type: TYPES.Bit };
const int = { type: TYPES.Int };
const date = { type: TYPES.DateTime2, scale: 3 };
const text = (length) => ({ type: TYPES.NVarChar, length });
const max = { type: TYPES.NVarChar, length: Infinity };

// Insert order respects foreign keys. `from` receives the snapshot scope.
const TABLES = [
  {
    name: "auth_users",
    secret: true,
    columns: { id: guid, email: text(320), password_hash: { type: TYPES.VarChar, length: 72 }, email_confirmed_at: date, last_sign_in_at: date, password_changed_at: date, created_at: date, updated_at: date },
    select: () => ({
      text: `select id, email, encrypted_password as password_hash, email_confirmed_at, last_sign_in_at,
             null::timestamptz as password_changed_at, created_at, updated_at
             from auth.users where deleted_at is null order by id`,
    }),
  },
  { name: "companies", columns: { id: guid, name: text(200), slug: text(100), is_active: bit, guid_company: text(64), created_at: date, updated_at: date } },
  { name: "profiles", columns: { id: guid, email: text(320), full_name: text(200), is_platform_admin: bit, created_at: date, updated_at: date } },
  { name: "company_memberships", columns: { id: guid, company_id: guid, user_id: guid, is_active: bit, created_at: date } },
  { name: "permissions", columns: { id: guid, code: text(100), description: text(400), created_at: date } },
  { name: "roles", columns: { id: guid, company_id: guid, name: text(100), description: text(500), is_system: bit, created_at: date, updated_at: date } },
  { name: "role_permissions", columns: { role_id: guid, permission_id: guid } },
  { name: "membership_roles", columns: { membership_id: guid, role_id: guid } },
  { name: "ycloud_accounts", secret: true, columns: { id: guid, name: text(200), api_key_encrypted: text(1024), webhook_secret_encrypted: text(1024), ycloud_webhook_endpoint_id: text(64), api_key_last4: text(8), is_active: bit, created_at: date, updated_at: date } },
  { name: "inboxes", columns: { id: guid, company_id: guid, name: text(200), phone_number: text(32), ycloud_phone_number_id: text(64), waba_id: text(64), ycloud_account_id: guid, is_active: bit, created_at: date, updated_at: date } },
  { name: "membership_inboxes", columns: { membership_id: guid, inbox_id: guid } },
  { name: "contacts", json: ["metadata"], columns: { id: guid, company_id: guid, phone_number: text(32), name: text(1000), metadata: max, created_at: date, updated_at: date } },
  { name: "tags", columns: { id: guid, company_id: guid, name: text(200), color: text(32), position: int, is_kanban_column: bit, created_at: date } },
  { name: "contact_tags", columns: { contact_id: guid, tag_id: guid, created_at: date } },
  {
    name: "conversations",
    scoped: "id",
    columns: { id: guid, company_id: guid, inbox_id: guid, contact_id: guid, assignee_id: guid, status: text(20), last_message_at: date, last_inbound_at: date, window_expires_at: date, last_message_preview: text(400), unread_count: int, created_at: date, updated_at: date },
  },
  { name: "conversation_tags", scoped: "conversation_id", columns: { conversation_id: guid, tag_id: guid, created_at: date } },
  { name: "conversation_notes", scoped: "conversation_id", columns: { id: guid, conversation_id: guid, company_id: guid, author_id: guid, body: max, created_at: date } },
  {
    name: "tickets",
    scoped: "conversation_id",
    columns: { id: guid, company_id: guid, conversation_id: guid, title: text(500), description: max, status: text(20), priority: text(20), assignee_id: guid, created_by: guid, support_response: max, support_responded_at: date, support_responded_by: guid, created_at: date, updated_at: date },
  },
  {
    name: "messages",
    scoped: "conversation_id",
    sinceCutoff: "created_at",
    json: ["template_components", "raw_payload", "reactions"],
    columns: { id: guid, conversation_id: guid, company_id: guid, direction: text(8), type: text(64), body: max, template_name: text(512), template_language: text(32), template_components: max, ycloud_message_id: text(128), status: text(32), media_url: max, raw_payload: max, sent_by: guid, created_at: date, media_mime: text(255), media_filename: text(1024), media_sha256: text(128), wamid: text(256), reply_to_wamid: text(256), reactions: max },
  },
  // Only recent events: enough to recognize a YCloud retry, whose schedule ends after about 5.6 h.
  {
    name: "webhook_events",
    json: ["payload"],
    recentHours: 6,
    columns: { id: guid, ycloud_event_id: text(128), event_type: text(128), payload: max, processed_at: date },
  },
  { name: "error_logs", json: ["context"], columns: { id: guid, created_at: date, updated_at: date, level: text(8), status: text(16), source: text(200), message: max, error_name: text(256), error_code: text(128), http_status: int, stack: max, context: max, company_id: guid, user_id: guid, request_id: text(128), resolved_at: date, resolved_by: guid, resolution_note: max } },
];

// jsonb goes through ::text so numbers keep their exact form (10.4800).
function selectList(table) {
  return Object.keys(table.columns)
    .map((c) => (table.json?.includes(c) ? `${c}::text as ${c}` : `"${c}"`))
    .join(", ");
}

function sqlConnect() {
  const token = execSync(`az account get-access-token --subscription ${SUBSCRIPTION} --resource https://database.windows.net/ --query accessToken -o tsv`, { encoding: "utf8" }).trim();
  return new Promise((resolve, reject) => {
    const connection = new Connection({
      server: SERVER,
      authentication: { type: "azure-active-directory-access-token", options: { token } },
      options: { database: DATABASE, encrypt: true, connectTimeout: 30000, requestTimeout: 300000, rowCollectionOnRequestCompletion: true, useUTC: true, lowerCaseGuids: true },
    });
    connection.on("connect", (err) => (err ? reject(err) : resolve(connection)));
    connection.on("error", () => {});
    connection.connect();
  });
}

const sqlRun = (connection, statement) =>
  new Promise((resolve, reject) => {
    connection.execSqlBatch(
      new Request(statement, (err, _count, rows) =>
        err ? reject(err) : resolve((rows ?? []).map((row) => Object.fromEntries(row.map((c) => [c.metadata.colName, c.value])))),
      ),
    );
  });

async function pgConnect() {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, ""), ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function resourceStats(connection) {
  const [row] = await sqlRun(connection, "select top 1 avg_cpu_percent as cpu, avg_data_io_percent as io, avg_log_write_percent as log_write, end_time from sys.dm_db_resource_stats order by end_time desc");
  return row;
}

let peak = 0;
async function throttle(connection) {
  for (;;) {
    const stats = await resourceStats(connection);
    const load = Math.max(stats.cpu, stats.io, stats.log_write);
    peak = Math.max(peak, load);
    if (load < THROTTLE_PERCENT) return;
    log(`base al ${load}% (cpu ${stats.cpu}, io ${stats.io}, log ${stats.log_write}); espero 15 s`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}

function bulkInsert(connection, table, rows) {
  return new Promise((resolve, reject) => {
    const bulk = connection.newBulkLoad(`chatbase.${table.name}`, { keepNulls: true, checkConstraints: true }, (err, count) => (err ? reject(err) : resolve(count)));
    // Declaring a NOT NULL column as nullable fails with error 4816.
    for (const [column, spec] of Object.entries(table.columns)) {
      bulk.addColumn(column, spec.type, { nullable: table.nullable.has(column), length: spec.length, scale: spec.scale });
    }
    connection.execBulkLoad(bulk, rows);
  });
}

async function copy(connection, table, rows) {
  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    await throttle(connection);
    copied += await bulkInsert(connection, table, rows.slice(i, i + BATCH));
  }
  return copied;
}

async function preflight() {
  const sql = await sqlConnect();
  console.log("destino:", await sqlRun(sql, "select db_name() as db, suser_sname() as login, is_member('db_owner') as owner, sysutcdatetime() as now_utc, cast(databasepropertyex(db_name(), 'Collation') as nvarchar(128)) as collation"));
  console.log("esquemas con tablas:", await sqlRun(sql, "select s.name, count(*) as tablas from sys.tables t join sys.schemas s on s.schema_id = t.schema_id group by s.name order by s.name"));
  console.log("esquema chatbase existe:", (await sqlRun(sql, "select schema_id('chatbase') as id"))[0].id !== null);
  console.log("triggers de base:", await sqlRun(sql, "select name from sys.triggers where parent_class = 0"));
  console.log("usuarios db_owner:", await sqlRun(sql, "select p.name, p.type_desc from sys.database_role_members m join sys.database_principals p on p.principal_id = m.member_principal_id join sys.database_principals r on r.principal_id = m.role_principal_id where r.name = 'db_owner'"));
  console.log("sesiones activas:", await sqlRun(sql, "select count(*) as n from sys.dm_exec_sessions where is_user_process = 1"));
  console.log("carga ultima hora:", await sqlRun(sql, "select count(*) as muestras, avg(avg_cpu_percent) as cpu_prom, max(avg_cpu_percent) as cpu_max, max(avg_data_io_percent) as io_max, max(avg_log_write_percent) as log_max from sys.dm_db_resource_stats"));
  sql.close();

  const source = await pgConnect();
  const info = await source.query("select current_database() as db, current_user as usr, inet_server_port() as port, (select count(*) from auth.users) as usuarios, now() - interval '2 months' as corte");
  console.log("origen:", info.rows[0]);
  const scope = await source.query(`select
    (select count(*) from public.conversations) as conversaciones,
    (select count(*) from public.conversations where last_message_at >= now() - interval '2 months') as conversaciones_en_ventana,
    (select count(*) from public.messages where created_at >= now() - interval '2 months') as mensajes_en_ventana`);
  console.log("alcance:", scope.rows[0]);
  await source.end();
}

async function applyDdl() {
  if (option("confirm") !== DATABASE) throw new Error(`Usa --confirm ${DATABASE}`);
  const sql = await sqlConnect();
  const [{ id }] = await sqlRun(sql, "select schema_id('chatbase') as id");
  if (id !== null) throw new Error("El esquema chatbase ya existe");
  const batches = readFileSync(new URL("../../db/sqlserver/001_baseline.sql", import.meta.url), "utf8").split(/^\s*GO\s*$/m).map((b) => b.trim()).filter(Boolean);
  for (const batch of batches) await sqlRun(sql, batch);
  console.log("tablas:", await sqlRun(sql, "select count(*) as n from sys.tables where schema_id = schema_id('chatbase')"));
  sql.close();
}

const sha = (value) => createHash("sha256").update(value ?? "").digest("hex");
const normalize = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value ?? null;
};
// SQL Server ignores trailing spaces in comparisons but stores them; values must match as stored.
const fingerprint = (row, columns) => sha(JSON.stringify(columns.map((c) => normalize(row[c]))));

async function load() {
  if (option("confirm") !== DATABASE) throw new Error(`Usa --confirm ${DATABASE}`);
  const months = Number(option("months") ?? 2);
  const sql = await sqlConnect();
  const counts = await sqlRun(sql, `select sum(p.rows) as n from sys.tables t join sys.partitions p on p.object_id = t.object_id and p.index_id in (0, 1) where t.schema_id = schema_id('chatbase')`);
  if (Number(counts[0].n) > 0) throw new Error("El esquema chatbase ya tiene filas; no se carga encima");

  const source = await pgConnect();
  await source.query("begin transaction isolation level repeatable read read only");
  const { rows: [{ cutoff, snapshot }] } = await source.query(`select now() - make_interval(months => $1::int) as cutoff, now() as snapshot`, [months]);
  log(`snapshot ${snapshot.toISOString()}, corte ${cutoff.toISOString()}`);

  const { rows: scopeRows } = await source.query(
    `select id from public.conversations c where c.last_message_at >= $1
       or exists (select 1 from public.conversation_notes n where n.conversation_id = c.id)
       or exists (select 1 from public.tickets t where t.conversation_id = c.id)`,
    [cutoff],
  );
  const conversationIds = scopeRows.map((r) => r.id);
  log(`conversaciones en alcance: ${conversationIds.length}`);

  const report = [];
  const started = Date.now();
  for (const table of TABLES) {
    const t0 = Date.now();
    let copied = 0;
    let expected = 0;
    table.nullable = new Set(
      (await sqlRun(sql, `select name from sys.columns where object_id = object_id('chatbase.${table.name}') and is_nullable = 1`)).map((c) => c.name),
    );
    try {
      if (table.scoped) {
        // Small id groups use the existing index and never need a sort on the Supabase side.
        const list = selectList(table);
        const sinceClause = table.sinceCutoff ? ` and ${table.sinceCutoff} >= $2` : "";
        for (let i = 0; i < conversationIds.length; i += 200) {
          const params = [conversationIds.slice(i, i + 200)];
          if (table.sinceCutoff) params.push(cutoff);
          const { rows } = await source.query(`select ${list} from public.${table.name} where ${table.scoped} = any($1::uuid[])${sinceClause}`, params);
          expected += rows.length;
          copied += await copy(sql, table, rows);
          if (table.name === "messages" && i % 2000 === 0) log(`messages: ${copied} filas, pico ${peak}%`);
        }
      } else {
        const query = table.select
          ? table.select()
          : table.recentHours
            ? {
                text: `select ${selectList(table)} from public.${table.name} where processed_at >= $1::timestamptz - make_interval(hours => $2::int)`,
                values: [snapshot, table.recentHours],
              }
            : { text: `select ${selectList(table)} from public.${table.name}` };
        const { rows } = await source.query(query);
        expected = rows.length;
        copied = await copy(sql, table, rows);
      }
    } catch (err) {
      const detail = table.secret ? `error ${err.number ?? "sin numero"}` : `${err.number ?? ""} ${String(err.message).slice(0, 200)}`;
      throw new Error(`Fallo en ${table.name}: ${detail}`);
    }
    report.push({ tabla: table.name, origen: expected, copiadas: copied, segundos: Math.round((Date.now() - t0) / 1000) });
    log(`${table.name}: ${copied}/${expected} en ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  log(`carga terminada en ${Math.round((Date.now() - started) / 1000)} s; pico de carga ${peak}%`);

  // Everything written after this point is what the return to Supabase has to copy back.
  await sqlRun(sql, `
    DELETE FROM chatbase.app_flags WHERE [key] = 'cut_version';
    INSERT INTO chatbase.app_flags ([key], value) VALUES ('cut_version', CAST(CAST(@@DBTS AS bigint) AS nvarchar(32)));`);

  // Verification against the same snapshot.
  const problems = [];
  for (const { tabla, origen } of report) {
    const [{ n }] = await sqlRun(sql, `select count_big(*) as n from chatbase.${tabla}`);
    if (Number(n) !== origen) problems.push(`${tabla}: destino ${n}, origen ${origen}`);
  }
  const untrusted = await sqlRun(sql, "select count(*) as n from sys.foreign_keys where schema_id = schema_id('chatbase') and (is_not_trusted = 1 or is_disabled = 1)");
  const untrustedChecks = await sqlRun(sql, "select count(*) as n from sys.check_constraints where schema_id = schema_id('chatbase') and (is_not_trusted = 1 or is_disabled = 1)");

  // Password hashes are compared by digest and never printed.
  const { rows: sourceUsers } = await source.query("select id, encrypted_password as hash, email from auth.users where deleted_at is null");
  const targetUsers = new Map((await sqlRun(sql, "select id, password_hash as hash, email from chatbase.auth_users")).map((u) => [u.id, u]));
  let hashesEqual = 0;
  let emailsEqual = 0;
  for (const user of sourceUsers) {
    const target = targetUsers.get(user.id);
    if (target && sha(target.hash) === sha(user.hash)) hashesEqual += 1;
    if (target && target.email === user.email) emailsEqual += 1;
  }

  // Random message sample, field by field, including emoji and exact JSON text.
  const messageTable = TABLES.find((t) => t.name === "messages");
  const columns = Object.keys(messageTable.columns);
  const sample = await sqlRun(sql, `select top 500 ${columns.map((c) => `[${c}]`).join(", ")} from chatbase.messages order by newid()`);
  let sampleDifferent = 0;
  const differentColumns = new Set();
  for (const target of sample) {
    const { rows: [origin] } = await source.query(`select ${selectList(messageTable)} from public.messages where id = $1`, [target.id]);
    if (!origin) {
      sampleDifferent += 1;
      continue;
    }
    origin.created_at = new Date(Math.floor(origin.created_at.getTime()));
    if (fingerprint(origin, columns) !== fingerprint(target, columns)) {
      sampleDifferent += 1;
      for (const c of columns) if (normalize(origin[c]) !== normalize(target[c])) differentColumns.add(c);
    }
  }
  const { rows: [emoji] } = await source.query(`select count(*) as n from public.messages where created_at >= $1 and conversation_id = any($2::uuid[]) and body ~ '[\\U00010000-\\U0010FFFF]'`, [cutoff, conversationIds]);
  const [targetEmoji] = await sqlRun(sql, `select count(*) as n from chatbase.messages where body like N'%' + nchar(55357) + N'%' collate Latin1_General_100_BIN2`);

  await source.query("rollback");
  await source.end();
  console.log(JSON.stringify({
    corte: cutoff.toISOString(),
    snapshot: snapshot.toISOString(),
    tablas: report,
    diferenciasConteo: problems,
    fkSinConfianza: untrusted[0].n,
    checksSinConfianza: untrustedChecks[0].n,
    usuarios: { origen: sourceUsers.length, hashesIguales: hashesEqual, emailsIguales: emailsEqual },
    muestraMensajes: { revisados: sample.length, diferentes: sampleDifferent, columnas: [...differentColumns] },
    emoji: { origenConSuplementarios: Number(emoji.n), destinoConD83D: targetEmoji.n },
    picoCargaPorciento: peak,
  }, null, 2));
  console.log("estado despues:", await resourceStats(sql));
  sql.close();
}

/** Empties chatbase so `load` can run again. Only ever touches this schema. */
async function wipe() {
  if (option("confirm") !== DATABASE) throw new Error(`Usa --confirm ${DATABASE}`);
  const sql = await sqlConnect();
  for (const table of [...TABLES].reverse()) {
    await sqlRun(sql, `DELETE FROM chatbase.${table.name}`);
    log(`vaciada ${table.name}`);
  }
  await sqlRun(sql, "DELETE FROM chatbase.webhook_events");
  // chatbase.webhook_inbox stays: it may hold captured webhooks that are still to be processed.
  sql.close();
}

/**
 * Faster than `wipe` on a full copy: drops this schema's tables and creates them again. Discards
 * chatbase.webhook_inbox too, so it refuses while captured webhooks are pending.
 */
async function recreate() {
  if (option("confirm") !== DATABASE) throw new Error(`Usa --confirm ${DATABASE}`);
  const sql = await sqlConnect();
  const [{ pending }] = await sqlRun(sql, "SELECT COUNT(*) AS pending FROM chatbase.webhook_inbox WHERE processed_at IS NULL");
  if (pending > 0) throw new Error(`Hay ${pending} webhooks capturados sin procesar`);
  const foreignKeys = await sqlRun(sql, `
    SELECT 'ALTER TABLE chatbase.' + OBJECT_NAME(parent_object_id) + ' DROP CONSTRAINT ' + name AS statement
    FROM sys.foreign_keys WHERE schema_id = SCHEMA_ID('chatbase')`);
  for (const { statement } of foreignKeys) await sqlRun(sql, statement);
  const tables = await sqlRun(sql, "SELECT name FROM sys.tables WHERE schema_id = SCHEMA_ID('chatbase')");
  for (const { name } of tables) await sqlRun(sql, `DROP TABLE chatbase.${name}`);
  log(`eliminadas ${tables.length} tablas`);
  for (const file of ["001_baseline.sql", "002_change_version.sql"]) {
    const batches = readFileSync(new URL(`../../db/sqlserver/${file}`, import.meta.url), "utf8").split(/^\s*GO\s*$/m).map((b) => b.trim()).filter(Boolean);
    for (const batch of batches) await sqlRun(sql, batch);
    log(`aplicado ${file}`);
  }
  sql.close();
}

/** Applies one file from db/sqlserver, batch by batch. */
async function applyFile() {
  if (option("confirm") !== DATABASE) throw new Error(`Usa --confirm ${DATABASE}`);
  const file = option("file");
  if (!file || !/^\d{3}_[a-z_]+\.sql$/.test(file)) throw new Error("Usa --file 00x_nombre.sql");
  const sql = await sqlConnect();
  const batches = readFileSync(new URL(`../../db/sqlserver/${file}`, import.meta.url), "utf8").split(/^\s*GO\s*$/m).map((b) => b.trim()).filter(Boolean);
  for (const batch of batches) await sqlRun(sql, batch);
  log(`aplicado ${file}: ${batches.length} lotes`);
  sql.close();
}

/** Creates or updates the app's user, limited to this schema. The password comes from APP_PASSWORD. */
async function grantApp() {
  if (option("confirm") !== DATABASE) throw new Error(`Usa --confirm ${DATABASE}`);
  const password = required("APP_PASSWORD").replace(/'/g, "''");
  const sql = await sqlConnect();
  await sqlRun(sql, `
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'chatbase_app')
      CREATE USER chatbase_app WITH PASSWORD = '${password}', DEFAULT_SCHEMA = chatbase;
    ELSE
      ALTER USER chatbase_app WITH PASSWORD = '${password}';
    GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::chatbase TO chatbase_app;`);
  log("usuario de la app listo");
  sql.close();
}

const commands = { preflight, "apply-ddl": applyDdl, load, wipe, recreate, "apply-file": applyFile, "grant-app": grantApp };
if (!commands[command]) {
  console.error("Comandos: preflight | apply-ddl | load | wipe | recreate | apply-file | grant-app");
  process.exit(2);
}
try {
  await commands[command]();
  process.exit(0);
} catch (err) {
  console.error(String(err.message ?? err).slice(0, 400));
  process.exit(1);
}
