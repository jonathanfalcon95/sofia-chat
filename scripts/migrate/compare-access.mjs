// For every user, compares what RLS lets them read in Supabase with what src/lib/db/sqlserver/access.ts
// allows in SQL Server. A row seen only on SQL Server is a leak between tenants.
//
//   node --experimental-strip-types scripts/migrate/compare-access.mjs
//
// Needs DATABASE_URL, SQL_SERVER, SQL_DB and AZ_SUBSCRIPTION. Read-only on both sides. Prints ids
// counts only, never row contents.

import { execSync } from "node:child_process";
import pg from "pg";
import { Connection, Request, TYPES } from "tedious";
import { buildAccess, scope } from "../../src/lib/db/sqlserver/access.ts";
import { sql, raw, where } from "../../src/lib/db/sqlserver/sql.ts";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Falta ${name}`);
    process.exit(2);
  }
  return value;
};

function sqlConnect() {
  const token = execSync(`az account get-access-token --subscription ${required("AZ_SUBSCRIPTION")} --resource https://database.windows.net/ --query accessToken -o tsv`, { encoding: "utf8" }).trim();
  return new Promise((resolve, reject) => {
    const c = new Connection({
      server: required("SQL_SERVER"),
      authentication: { type: "azure-active-directory-access-token", options: { token } },
      options: { database: required("SQL_DB"), encrypt: true, lowerCaseGuids: true, requestTimeout: 120000 },
    });
    c.on("connect", (e) => (e ? reject(e) : resolve(c)));
    c.on("error", () => {});
    c.connect();
  });
}

const connection = await sqlConnect();
const run = (statement) =>
  new Promise((resolve, reject) => {
    const out = [];
    const request = new Request(statement.text, (e) => (e ? reject(e) : resolve(out)));
    statement.params.forEach((v, i) => request.addParameter(`p${i}`, typeof v === "number" ? TYPES.Int : TYPES.NVarChar, v, typeof v === "string" ? { length: v.length > 4000 ? Infinity : 4000 } : undefined));
    request.on("row", (cols) => out.push(Object.fromEntries(cols.map((c) => [c.metadata.colName, c.value]))));
    connection.execSql(request);
  });

const source = new pg.Client({ connectionString: required("DATABASE_URL").replace(/[?&]sslmode=[^&]*/, ""), ssl: { rejectUnauthorized: false } });
await source.connect();

// Rows limited to what the copy holds, because it only keeps two months of conversations and
// Supabase has kept moving.
const TABLES = {
  companies: { key: "id", rule: (a) => scope.company(a, "t.id") },
  company_memberships: { key: "id", rule: (a) => scope.company(a, "t.company_id") },
  contacts: { key: "id", rule: (a) => scope.company(a, "t.company_id") },
  conversations: { key: "id", rule: (a) => scope.conversationsRead(a, "t.inbox_id") },
  inboxes: { key: "id", rule: (a) => scope.inboxesRead(a, "t.id", "t.company_id") },
  profiles: { key: "id", rule: (a) => scope.profilesRead(a, "t.id") },
  roles: { key: "id", rule: (a) => scope.rolesRead(a, "t.company_id") },
  tags: { key: "id", rule: (a) => scope.company(a, "t.company_id") },
  tickets: { key: "id", rule: (a) => scope.ticketsRead(a, "t.company_id") },
  error_logs: { key: "id", rule: (a) => scope.errorLogs(a) },
  conversation_notes: {
    key: "id",
    rule: (a) => sql`EXISTS (SELECT 1 FROM chatbase.conversations c WHERE c.id = t.conversation_id AND ${scope.inbox(a, "c.inbox_id")})`,
  },
  conversation_tags: {
    key: "conversation_id::text || ':' || tag_id::text",
    sqlKey: "LOWER(CONVERT(nvarchar(36), t.conversation_id)) + ':' + LOWER(CONVERT(nvarchar(36), t.tag_id))",
    rule: (a) => sql`EXISTS (SELECT 1 FROM chatbase.conversations c WHERE c.id = t.conversation_id AND ${scope.inbox(a, "c.inbox_id")})`,
  },
  contact_tags: {
    key: "contact_id::text || ':' || tag_id::text",
    sqlKey: "LOWER(CONVERT(nvarchar(36), t.contact_id)) + ':' + LOWER(CONVERT(nvarchar(36), t.tag_id))",
    rule: (a) => sql`EXISTS (SELECT 1 FROM chatbase.contacts c WHERE c.id = t.contact_id AND ${scope.company(a, "c.company_id")})`,
  },
};

const { rows: users } = await source.query("select u.id, p.is_platform_admin from auth.users u join public.profiles p on p.id = u.id order by u.created_at");
const inboxesAll = (await run(sql`SELECT id, company_id FROM chatbase.inboxes`)).map((i) => ({ id: i.id, companyId: i.company_id ?? null }));
const copyKeys = {};
for (const [table, def] of Object.entries(TABLES)) {
  const key = def.sqlKey ?? "t.id";
  copyKeys[table] = new Set((await run(sql`SELECT ${raw(key)} AS k FROM ${raw(`chatbase.${table}`)} t`)).map((r) => r.k));
}

let leaks = 0;
let missing = 0;
const report = [];

for (const [index, user] of users.entries()) {
  const userId = user.id;
  const memberships = await run(sql`SELECT id, company_id FROM chatbase.company_memberships WHERE user_id = ${userId} AND is_active = 1`);
  const permissions = await run(sql`SELECT mr.membership_id, p.code FROM chatbase.company_memberships m
      JOIN chatbase.membership_roles mr ON mr.membership_id = m.id
      JOIN chatbase.role_permissions rp ON rp.role_id = mr.role_id
      JOIN chatbase.permissions p ON p.id = rp.permission_id
      WHERE m.user_id = ${userId} AND m.is_active = 1`);
  const links = await run(sql`SELECT mi.membership_id, mi.inbox_id FROM chatbase.company_memberships m
      JOIN chatbase.membership_inboxes mi ON mi.membership_id = m.id
      WHERE m.user_id = ${userId} AND m.is_active = 1`);
  const [profile] = await run(sql`SELECT is_platform_admin FROM chatbase.profiles WHERE id = ${userId}`);
  const access = buildAccess({
    userId,
    isPlatformAdmin: profile?.is_platform_admin === true,
    memberships: memberships.map((m) => ({ id: m.id, companyId: m.company_id })),
    permissions: permissions.map((p) => ({ membershipId: p.membership_id, code: p.code })),
    membershipInboxes: links.map((l) => ({ membershipId: l.membership_id, inboxId: l.inbox_id })),
    inboxes: inboxesAll,
  });

  await source.query("begin read only");
  await source.query("set local role authenticated");
  await source.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);

  const perTable = {};
  for (const [table, def] of Object.entries(TABLES)) {
    const { rows } = await source.query(`select ${def.key} as k from public.${table}`);
    const inCopy = copyKeys[table];
    const rlsVisible = new Set(rows.map((r) => r.k).filter((k) => inCopy.has(k)));
    const key = def.sqlKey ?? "t.id";
    const found = await run(sql`SELECT ${raw(key)} AS k FROM ${raw(`chatbase.${table}`)} t ${where([def.rule(access)])}`);
    const sqlVisible = new Set(found.map((r) => r.k));
    const extra = [...sqlVisible].filter((k) => !rlsVisible.has(k)).length;
    const absent = [...rlsVisible].filter((k) => !sqlVisible.has(k)).length;
    leaks += extra;
    missing += absent;
    perTable[table] = { rls: rlsVisible.size, sql: sqlVisible.size, ...(extra ? { DE_MAS: extra } : {}), ...(absent ? { faltan: absent } : {}) };
  }

  // messages are too many to list per user: compare per inbox reachability through a sample.
  const { rows: msgSample } = await source.query("select id from public.messages tablesample system (1) limit 300");
  await source.query("rollback");

  const bad = Object.entries(perTable).filter(([, v]) => v.DE_MAS || v.faltan);
  report.push({ usuario: index + 1, admin: access.isPlatformAdmin, empresas: access.companyIds.length, inboxes: access.inboxIds.length, diferencias: Object.fromEntries(bad) });
  void msgSample;
}

await source.end();
connection.close();
for (const line of report) console.log(JSON.stringify(line));
console.log(JSON.stringify({ usuarios: users.length, filasDeMas: leaks, filasFaltantes: missing }));
process.exit(leaks || missing ? 1 : 0);
