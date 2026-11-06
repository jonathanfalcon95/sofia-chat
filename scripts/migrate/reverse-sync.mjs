// The way back: copies to Supabase everything written in SQL Server since the load.
//
//   node scripts/migrate/reverse-sync.mjs                  counts what would change
//   node scripts/migrate/reverse-sync.mjs --rehearse       applies it in a transaction, verifies, rolls back
//   node scripts/migrate/reverse-sync.mjs --apply --confirm <database>   applies and commits
//
// Reads DATABASE_URL, SQL_SERVER, SQL_DB and AZ_SUBSCRIPTION from the environment and signs in to
// SQL with the az CLI token. Run with the app in maintenance and capture mode, so nothing is
// writing on either side. Row values are never logged: auth_users holds password hashes.

import { execSync } from "node:child_process";
import pg from "pg";
import { Connection, Request, TYPES } from "tedious";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rehearse = args.includes("--rehearse");
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta ${name}`);
    process.exit(2);
  }
  return value;
};
const DATABASE = required("SQL_DB");
if (apply && args[args.indexOf("--confirm") + 1] !== DATABASE) {
  console.error(`Usa --confirm ${DATABASE}`);
  process.exit(2);
}

const JSON_COLUMNS = new Set(["metadata", "template_components", "raw_payload", "reactions", "context"]);
const BATCH = 200;

// Foreign key order. `key` is the primary key. `deletes` lists which rows may be removed from
// Supabase when they no longer exist in SQL Server: the app deletes these, and only inside what
// the copy holds, because Supabase keeps conversations older than the copy.
const TABLES = [
  { name: "companies", key: ["id"] },
  { name: "profiles", key: ["id"] },
  { name: "company_memberships", key: ["id"] },
  { name: "roles", key: ["id"], deletes: "all" },
  { name: "role_permissions", key: ["role_id", "permission_id"], deletes: "all" },
  { name: "membership_roles", key: ["membership_id", "role_id"], deletes: "all" },
  { name: "ycloud_accounts", key: ["id"] },
  { name: "inboxes", key: ["id"] },
  { name: "membership_inboxes", key: ["membership_id", "inbox_id"], deletes: "all" },
  { name: "contacts", key: ["id"] },
  { name: "tags", key: ["id"], deletes: "all" },
  { name: "contact_tags", key: ["contact_id", "tag_id"], deletes: "all" },
  { name: "conversations", key: ["id"] },
  { name: "conversation_tags", key: ["conversation_id", "tag_id"], deletes: "conversation_id" },
  { name: "conversation_notes", key: ["id"], deletes: "conversation_id" },
  { name: "tickets", key: ["id"] },
  { name: "messages", key: ["id"] },
  { name: "error_logs", key: ["id"] },
];

const token = execSync(`az account get-access-token --subscription ${required("AZ_SUBSCRIPTION")} --resource https://database.windows.net/ --query accessToken -o tsv`, { encoding: "utf8" }).trim();
const connection = await new Promise((resolve, reject) => {
  const c = new Connection({
    server: required("SQL_SERVER"),
    authentication: { type: "azure-active-directory-access-token", options: { token } },
    options: { database: DATABASE, encrypt: true, lowerCaseGuids: true, useUTC: true, requestTimeout: 300000 },
  });
  c.on("connect", (e) => (e ? reject(e) : resolve(c)));
  c.on("error", () => {});
  c.connect();
});
const run = (text, params = {}) =>
  new Promise((resolve, reject) => {
    const out = [];
    const request = new Request(text, (e) => (e ? reject(e) : resolve(out)));
    for (const [name, value] of Object.entries(params)) request.addParameter(name, TYPES.NVarChar, value);
    request.on("row", (cols) => {
      const row = {};
      for (const col of cols) {
        let value = col.value;
        if (value instanceof Date) value = value.toISOString();
        else if (typeof value === "string" && JSON_COLUMNS.has(col.metadata.colName)) value = JSON.parse(value);
        row[col.metadata.colName] = value;
      }
      out.push(row);
    });
    connection.execSql(request);
  });

const source = new pg.Client({ connectionString: required("DATABASE_URL").replace(/[?&]sslmode=[^&]*/, ""), ssl: { rejectUnauthorized: false } });
await source.connect();

const [flag] = await run("SELECT value FROM chatbase.app_flags WHERE [key] = 'cut_version'");
if (!flag) throw new Error("No hay cut_version: la carga no terminó");
const cut = flag.value;
log(`cambios desde la versión de corte`);

const changed = (table) =>
  run(
    `SELECT t.* FROM chatbase.${table} t
     WHERE t.change_version > CAST(CAST(@cut AS bigint) AS binary(8))`,
    { cut },
  ).then((rows) => rows.map(({ change_version: _ignored, ...row }) => row));

const keyOf = (row, key) => key.map((k) => row[k]).join(":");

/**
 * A message can already be in Supabase under another id, because YCloud's webhook created it there.
 * Its YCloud id is what identifies it, so that row gets updated and keeps its id.
 */
async function reconcileMessagesByYCloudId(rows) {
  const withYCloudId = rows.filter((r) => r.ycloud_message_id);
  if (!withYCloudId.length) return rows;
  const { rows: existing } = await source.query(
    "select id, ycloud_message_id from public.messages where ycloud_message_id = any($1::text[])",
    [withYCloudId.map((r) => r.ycloud_message_id)],
  );
  const idByYCloudId = new Map(existing.map((m) => [m.ycloud_message_id, m.id]));
  return rows.map((row) => {
    const id = row.ycloud_message_id && idByYCloudId.get(row.ycloud_message_id);
    return id ? { ...row, id } : row;
  });
}

async function upsert(table, key, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const updates = columns.filter((c) => !key.includes(c));
  const quoted = (c) => `"${c}"`;
  const action = updates.length
    ? `do update set ${updates.map((c) => `${quoted(c)} = excluded.${quoted(c)}`).join(", ")}`
    : "do nothing";
  for (let i = 0; i < rows.length; i += BATCH) {
    // jsonb_populate_recordset casts every value to its column's type on the Postgres side.
    await source.query(
      `insert into public.${table} (${columns.map(quoted).join(", ")})
       select ${columns.map(quoted).join(", ")} from jsonb_populate_recordset(null::public.${table}, $1::jsonb)
       on conflict (${key.map(quoted).join(", ")}) ${action}`,
      [JSON.stringify(rows.slice(i, i + BATCH))],
    );
  }
}

async function syncUsers() {
  const users = await run(
    `SELECT id, email, password_hash, email_confirmed_at, last_sign_in_at, created_at, updated_at
     FROM chatbase.auth_users WHERE change_version > CAST(CAST(@cut AS bigint) AS binary(8))`,
    { cut },
  );
  if (!users.length) return { changed: 0, created: 0 };
  const { rows: existing } = await source.query("select id from auth.users where id = any($1::uuid[])", [users.map((u) => u.id)]);
  const known = new Set(existing.map((u) => u.id));
  let created = 0;
  for (const user of users) {
    if (known.has(user.id)) {
      await source.query(
        `update auth.users set email = $2, encrypted_password = $3, last_sign_in_at = $4, updated_at = now() where id = $1`,
        [user.id, user.email, user.password_hash, user.last_sign_in_at],
      );
      continue;
    }
    created += 1;
    await source.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         confirmation_token, recovery_token, email_change, email_change_token_new)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, $3, $4,
         '{"provider":"email","providers":["email"]}', '{}', $5, now(), '', '', '', '')`,
      [user.id, user.email, user.password_hash, user.email_confirmed_at ?? user.created_at, user.created_at],
    );
    await source.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
       values ($1, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now())`,
      [user.id, user.email],
    );
  }
  return { changed: users.length, created };
}

async function removedRows(table) {
  const quoted = table.key.map((k) => `t."${k}"::text`).join(` || ':' || `);
  const sqlKey = table.key.map((k) => `LOWER(CONVERT(nvarchar(36), t.${k}))`).join(` + ':' + `);
  const inCopy = new Set((await run(`SELECT ${sqlKey} AS k FROM chatbase.${table.name} t`)).map((r) => r.k));
  let scope = "";
  const params = [];
  if (table.deletes === "conversation_id") {
    const ids = (await run("SELECT id FROM chatbase.conversations")).map((r) => r.id);
    scope = "where t.conversation_id = any($1::uuid[])";
    params.push(ids);
  }
  const { rows } = await source.query(`select ${quoted} as k from public.${table.name} t ${scope}`, params);
  return rows.map((r) => r.k).filter((k) => !inCopy.has(k));
}

async function deleteRows(table, keys) {
  for (const k of keys) {
    const parts = k.split(":");
    await source.query(
      `delete from public.${table.name} where ${table.key.map((c, i) => `"${c}" = $${i + 1}::uuid`).join(" and ")}`,
      parts,
    );
  }
}

const report = [];
const writing = apply || rehearse;
if (writing) await source.query("begin");
try {
  const users = writing ? await syncUsers() : { changed: (await run("SELECT COUNT(*) AS n FROM chatbase.auth_users WHERE change_version > CAST(CAST(@cut AS bigint) AS binary(8))", { cut }))[0].n, created: "?" };
  report.push({ tabla: "auth_users", ...users });

  for (const table of TABLES) {
    const rows = await changed(table.name);
    const removed = table.deletes ? await removedRows(table) : [];
    report.push({ tabla: table.name, cambiadas: rows.length, borradas: removed.length });
    if (writing) {
      const prepared = table.name === "messages" ? await reconcileMessagesByYCloudId(rows) : rows;
      await upsert(table.name, table.key, prepared);
      await deleteRows(table, removed);
    }
  }

  if (writing) {
    // After applying, every row that changed must read back the same on the key columns.
    for (const table of TABLES) {
      let rows = await changed(table.name);
      if (!rows.length) continue;
      if (table.name === "messages") rows = await reconcileMessagesByYCloudId(rows);
      const wanted = new Set(rows.map((r) => keyOf(r, table.key)));
      const quoted = table.key.map((k) => `t."${k}"::text`).join(` || ':' || `);
      const { rows: found } = await source.query(
        `select ${quoted} as k from public.${table.name} t where ${quoted} = any($1::text[])`,
        [[...wanted]],
      );
      if (found.length !== wanted.size) {
        throw new Error(`${table.name}: esperadas ${wanted.size} filas, hay ${found.length}`);
      }
    }
    log("verificación de claves correcta");
  }

  if (apply) {
    await source.query("commit");
    log("APLICADO en Supabase");
  } else if (rehearse) {
    await source.query("rollback");
    log("ensayo correcto, revertido: Supabase no cambió");
  }
} catch (err) {
  if (writing) await source.query("rollback").catch(() => {});
  console.error(`Falló, sin cambios en Supabase: ${String(err.message).slice(0, 300)}`);
  process.exitCode = 1;
}

for (const line of report) console.log(JSON.stringify(line));
await source.end();
connection.close();
process.exit(process.exitCode ?? 0);
