// Runs every function of src/lib/db/repos against both backends and checks they agree.
//
//   npx -y tsx scripts/migrate/compare-repos.ts [reads] [users] [writes] [errors]
//
// Needs SQL_SERVER, SQL_DB, SQL_USER, SQL_PASSWORD, NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY. No section argument runs all of them.
//
//   reads   same call with a service-role client and with systemSqlDb(), compared deep.
//   users   the reads with userSqlDb() for a platform admin, a company admin, an agent and an
//           anonymous caller, checking they run and that rows respect the company.
//   writes  every write on the SQL Server copy, on fake rows named prueba-migracion-repos-*, which
//           are deleted again. Nothing is ever written to Supabase.
//   errors  bad ids, `.single()` semantics and collations.
//
// Supabase is production and is only read. messages has no index on created_at there, so the two
// functions that would scan it (listInboundMessagesAfter, countMessagesSince without inboxes) are
// checked through primary key lookups and a single small inbox instead.
//
// Prints function names, column paths and counts, never row contents or ids.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { encodePageCursor } from "@/lib/conversations/page-cursor";
import { ilikePattern } from "@/lib/pagination";
import {
  hasCompanyAccess,
  hasPermission,
  inboxesWithPermission,
  type Access,
} from "@/lib/db/sqlserver/access";
import {
  accessOf,
  inTransaction,
  isSqlDb,
  systemSqlDb,
  userSqlDb,
  type SqlDb,
} from "@/lib/db/sqlserver/db";
import { raw, sql, uuidList } from "@/lib/db/sqlserver/sql";
import * as companies from "@/lib/db/repos/companies";
import * as contacts from "@/lib/db/repos/contacts";
import * as conversations from "@/lib/db/repos/conversations";
import * as dashboard from "@/lib/db/repos/dashboard";
import * as errors from "@/lib/db/repos/errors";
import * as inboxes from "@/lib/db/repos/inboxes";
import * as kanban from "@/lib/db/repos/kanban";
import * as media from "@/lib/db/repos/media";
import * as memberships from "@/lib/db/repos/memberships";
import * as messages from "@/lib/db/repos/messages";
import * as messaging from "@/lib/db/repos/messaging";
import * as notes from "@/lib/db/repos/notes";
import * as profiles from "@/lib/db/repos/profiles";
import * as roles from "@/lib/db/repos/roles";
import * as storage from "@/lib/db/repos/storage";
import * as tags from "@/lib/db/repos/tags";
import * as tickets from "@/lib/db/repos/tickets";
import * as ycloud from "@/lib/db/repos/ycloud";

// ---------------------------------------------------------------------------------------------
// Harness: every repository call is recorded, timed and checked for forbidden SQL errors.
// ---------------------------------------------------------------------------------------------

const MODULES: Record<string, Record<string, unknown>> = {
  companies, contacts, conversations, dashboard, errors, inboxes, kanban, media, memberships,
  messages, messaging, notes, profiles, roles, storage, tags, tickets, ycloud,
};

/** Reached from here only by reference: exercised by another check or on purpose not at all. */
const NOT_EXERCISED: Record<string, string> = {
  "storage.uploadChatMedia": "writes to production Supabase Storage on both backends",
  "ycloud.processYCloudWebhookForAccount": "covered by sqlserver/webhook.test.ts, owned elsewhere",
  "ycloud.processYCloudWebhook": "covered by sqlserver/webhook.test.ts, owned elsewhere",
};

type Hit = { system: number; user: number; supabase: number; maxMs: number; sqlErrors: Set<string> };
const hits = new Map<string, Hit>();
const slow: Array<{ fn: string; ms: number; actor: string }> = [];
const FORBIDDEN_CODES = new Set(["8169", "468", "245", "241"]);
const forbidden: Array<{ fn: string; code: string; section: string }> = [];
let section = "";

function hit(name: string): Hit {
  let found = hits.get(name);
  if (!found) {
    found = { system: 0, user: 0, supabase: 0, maxMs: 0, sqlErrors: new Set() };
    hits.set(name, found);
  }
  return found;
}

function instrument(): Record<string, Record<string, (...args: any[]) => Promise<any>>> {
  const out: Record<string, Record<string, any>> = {};
  for (const [moduleName, mod] of Object.entries(MODULES)) {
    out[moduleName] = {};
    for (const [fnName, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      const name = `${moduleName}.${fnName}`;
      hit(name);
      out[moduleName][fnName] = async (...args: unknown[]) => {
        const db = args[0];
        const record = hit(name);
        if (!isSqlDb(db)) {
          record.supabase++;
          return (fn as any)(...args);
        }
        const actor = db.actor.kind;
        record[actor]++;
        const started = performance.now();
        const result = await (fn as any)(...args);
        const ms = performance.now() - started;
        record.maxMs = Math.max(record.maxMs, ms);
        if (ms > 1000) slow.push({ fn: name, ms: Math.round(ms), actor });
        const code = result?.error?.code;
        if (code) record.sqlErrors.add(String(code));
        if (code && FORBIDDEN_CODES.has(String(code))) {
          forbidden.push({ fn: name, code: String(code), section });
        }
        return result;
      };
    }
  }
  return out;
}

const R = instrument();

type Finding = { section: string; fn: string; what: string };
const findings: Finding[] = [];
const explained = new Map<string, number>();
const notes_: string[] = [];
let checks = 0;

function fail(fn: string, what: string) {
  findings.push({ section, fn, what });
}

function explain(kind: string, n = 1) {
  if (n) explained.set(kind, (explained.get(kind) ?? 0) + n);
}

function check(fn: string, label: string, condition: unknown) {
  checks++;
  if (!condition) fail(fn, label);
}

const hash = (value: unknown) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 8);

// ---------------------------------------------------------------------------------------------
// Deep comparison. Paths and shapes only reach the output, never values.
// ---------------------------------------------------------------------------------------------

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An instant truncated to milliseconds, or null when the text isn't a timestamp. */
function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = TIMESTAMP.exec(value);
  if (!m) return null;
  const fraction = (m[3] ?? ".").slice(1).padEnd(3, "0").slice(0, 3);
  let zone = m[4] ?? "Z";
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
  const time = Date.parse(`${m[1]}T${m[2]}.${fraction}${zone}`);
  return Number.isNaN(time) ? null : time;
}

function normalized(value: unknown): unknown {
  const time = instant(value);
  if (time !== null) return { $instant: time };
  if (typeof value === "string" && UUID_SHAPE.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized).map(canonical).sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, normalized(v)]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(normalized(value));
}

function shapeOf(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

function stringHint(a: string, b: string) {
  if (a.toLowerCase() === b.toLowerCase()) return "case-only";
  if (a.trim() === b.trim()) return "whitespace-only";
  if (a.normalize("NFC") === b.normalize("NFC")) return "unicode-normalization";
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `first-diff-at-${i}`;
}

type Diff = { path: string; kind: string };

function deepDiff(a: unknown, b: unknown, path: string, out: Diff[]) {
  if (a === undefined || b === undefined) {
    if (a !== b) out.push({ path, kind: a === undefined ? "only-sqlserver" : "only-supabase" });
    return;
  }
  if (instant(a) !== null && instant(b) !== null) {
    if (instant(a) !== instant(b)) out.push({ path, kind: `instant-differs(${instant(a)! - instant(b)!}ms)` });
    return;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return;
    if (UUID_SHAPE.test(a) && a.toLowerCase() === b.toLowerCase()) return;
    out.push({ path, kind: `string(${a.length}) vs string(${b.length}) ${stringHint(a, b)}` });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path, kind: `array(${a.length}) vs array(${b.length})` });
      return;
    }
    const sortedA = [...a].sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
    const sortedB = [...b].sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
    sortedA.forEach((item, i) => deepDiff(item, sortedB[i], `${path}[]`, out));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) {
      deepDiff((a as any)[key], (b as any)[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (a !== b) {
    const scalars = typeof a === "boolean" && typeof b === "boolean" ? `${a} vs ${b}` : `${shapeOf(a)} vs ${shapeOf(b)}`;
    out.push({ path, kind: scalars });
  }
}

// ---------------------------------------------------------------------------------------------
// Supabase and copy snapshots, to tell rows that moved on since the copy from real differences.
// ---------------------------------------------------------------------------------------------

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sys = systemSqlDb();

type Snapshot = { sb: Map<string, any>; sql: Map<string, any> };
const SNAPSHOT_COLUMNS: Record<string, string> = {
  companies: "id, created_at, updated_at",
  profiles: "id, created_at, updated_at",
  roles: "id, company_id, created_at, updated_at",
  inboxes: "id, company_id, created_at, updated_at",
  contacts: "id, company_id, created_at, updated_at",
  conversations:
    "id, company_id, inbox_id, contact_id, assignee_id, status, last_message_at, window_expires_at, created_at, updated_at",
  tickets: "id, company_id, created_at, updated_at",
  error_logs: "id, company_id, created_at, updated_at",
  company_memberships: "id, company_id, user_id, created_at",
  tags: "id, company_id, created_at",
};
const snapshots: Record<string, Snapshot> = {};

async function pagedSupabase(table: string, columns: string) {
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).order("id").range(from, from + 999);
    if (error) throw new Error(`supabase snapshot ${table}: ${error.code}`);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) return all;
  }
}

async function loadSnapshots() {
  for (const [table, columns] of Object.entries(SNAPSHOT_COLUMNS)) {
    const [fromSb, fromSql] = await Promise.all([
      pagedSupabase(table, columns),
      sys.run(sql`SELECT ${raw(columns)} FROM ${raw(`chatbase.${table}`)}`),
    ]);
    snapshots[table] = {
      sb: new Map(fromSb.map((row) => [row.id, row])),
      sql: new Map(fromSql.map((row) => [row.id as string, row])),
    };
  }
}

/** The row's version on Supabase is not the copy's, so it moved on after the load. */
function changedSinceCopy(table: string, id: unknown) {
  const snapshot = snapshots[table];
  if (!snapshot) return false;
  const a = snapshot.sb.get(id as string);
  const b = snapshot.sql.get(id as string);
  if (!a || !b) return false;
  if (a.updated_at === undefined) return false;
  return instant(a.updated_at) !== instant(b.updated_at);
}

const RELATED_TO_CONVERSATION = (row: any): Array<[string, unknown]> => [
  ["conversations", row.id],
  ["contacts", row.contact_id ?? snapshots.conversations?.sb.get(row.id)?.contact_id],
];

/** Reads the row again on both sides: the run lasts minutes and production keeps moving. */
async function refreshSnapshot(table: string, id: unknown) {
  const snapshot = snapshots[table];
  if (!snapshot || typeof id !== "string") return;
  const columns = SNAPSHOT_COLUMNS[table];
  const { data } = await sb.from(table).select(columns).eq("id", id).maybeSingle();
  if (data) snapshot.sb.set(id, data);
  const [fresh] = await sys.run(sql`SELECT ${raw(columns)} FROM ${raw(`chatbase.${table}`)} WHERE id = ${id}`);
  if (fresh) snapshot.sql.set(id, fresh);
}

/** The conversation's tag links are not the copy's. */
async function tagLinksMoved(conversationId: string) {
  const { data } = await sb.from("conversation_tags").select("tag_id").eq("conversation_id", conversationId);
  const found = await sys.run(sql`SELECT tag_id FROM chatbase.conversation_tags WHERE conversation_id = ${conversationId}`);
  const a = (data ?? []).map((row: any) => row.tag_id).sort().join();
  const b = found.map((row) => row.tag_id as string).sort().join();
  return a !== b;
}

async function existsOnSql(table: string, id: string) {
  const snapshot = snapshots[table];
  if (snapshot) return snapshot.sql.has(id);
  const found = await sys.run(sql`SELECT TOP (1) 1 AS one FROM ${raw(`chatbase.${table}`)} WHERE id = ${id}`);
  return found.length > 0;
}

async function existsOnSupabase(table: string, id: string) {
  const snapshot = snapshots[table];
  if (snapshot) return snapshot.sb.has(id);
  const { data } = await sb.from(table).select("id").eq("id", id).maybeSingle();
  return Boolean(data);
}

// ---------------------------------------------------------------------------------------------
// Real arguments, picked from rows that exist on both sides and haven't moved since the copy.
// ---------------------------------------------------------------------------------------------

const NIL = "00000000-0000-4000-8000-000000000000";
const FAR_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

type Seed = {
  company: string;
  companyGuid: string;
  inbox: string;
  inboxes: string[];
  conversation: string;
  conversationAssigned: string;
  assignee: string;
  contact: string;
  contactPhone: string;
  contactSearch: string;
  digitsSearch: string;
  tagKanban: string;
  tagContact: string;
  contactWithTag: string;
  role: string;
  roleName: string;
  membership: string;
  memberUser: string;
  message: string;
  messageConversation: string;
  ycloudMessageId: string;
  mediaMessage: string;
  ticket: string;
  noteConversation: string;
};

let cutoff = "";

function emptySeed(company: string): Seed {
  return {
    company, companyGuid: "", inbox: NIL, inboxes: [], conversation: NIL, conversationAssigned: NIL,
    assignee: NIL, contact: NIL, contactPhone: "none", contactSearch: "zzzzzzzz", digitsSearch: "",
    tagKanban: NIL, tagContact: NIL, contactWithTag: NIL, role: NIL, roleName: "none",
    membership: NIL, memberUser: NIL, message: NIL, messageConversation: NIL, ycloudMessageId: "none",
    mediaMessage: NIL, ticket: NIL, noteConversation: NIL,
  };
}

async function buildSeed(company: string): Promise<Seed> {
  const s = emptySeed(company);
  const [c] = await sys.run(sql`SELECT guid_company FROM chatbase.companies WHERE id = ${company}`);
  s.companyGuid = (c?.guid_company as string) ?? "";

  const inboxRows = await sys.run(sql`SELECT id FROM chatbase.inboxes WHERE company_id = ${company}`);
  s.inboxes = inboxRows.map((row) => row.id as string);
  if (s.inboxes[0]) s.inbox = s.inboxes[0];

  const candidates = await sys.run(sql`
    SELECT TOP (300) c.id, c.contact_id, c.assignee_id, c.inbox_id
    FROM chatbase.conversations c
    WHERE c.company_id = ${company}
      AND EXISTS (SELECT 1 FROM chatbase.messages m WHERE m.conversation_id = c.id)
    ORDER BY c.last_message_at DESC, c.id DESC`);
  const stable = candidates.filter(
    (row) => !changedSinceCopy("conversations", row.id) && !changedSinceCopy("contacts", row.contact_id)
      && snapshots.conversations.sb.has(row.id as string),
  );
  if (stable[0]) {
    s.conversation = stable[0].id as string;
    s.contact = stable[0].contact_id as string;
    s.inbox = stable[0].inbox_id as string;
  }
  const assigned = stable.find((row) => row.assignee_id);
  if (assigned) {
    s.conversationAssigned = assigned.id as string;
    s.assignee = assigned.assignee_id as string;
  }

  if (s.contact !== NIL) {
    const [contact] = await sys.run(sql`SELECT phone_number, name FROM chatbase.contacts WHERE id = ${s.contact}`);
    s.contactPhone = contact.phone_number as string;
    s.digitsSearch = s.contactPhone.replace(/\D/g, "").slice(-7);
    const words = String(contact.name ?? "").split(/\s+/).filter((w) => /^[\p{L}]{4,}$/u.test(w));
    s.contactSearch = (words[0] ?? s.digitsSearch).toLowerCase();
  }

  const [kanbanTag] = await sys.run(sql`
    SELECT TOP (1) ct.tag_id, COUNT(*) AS n FROM chatbase.conversation_tags ct
    JOIN chatbase.tags t ON t.id = ct.tag_id
    WHERE t.company_id = ${company} AND t.is_kanban_column = 1
    GROUP BY ct.tag_id ORDER BY n DESC`);
  if (kanbanTag) s.tagKanban = kanbanTag.tag_id as string;

  const [contactTag] = await sys.run(sql`
    SELECT TOP (1) ct.tag_id, ct.contact_id FROM chatbase.contact_tags ct
    JOIN chatbase.tags t ON t.id = ct.tag_id
    WHERE t.company_id = ${company}`);
  if (contactTag) {
    s.tagContact = contactTag.tag_id as string;
    s.contactWithTag = contactTag.contact_id as string;
  } else {
    const [anyTag] = await sys.run(sql`
      SELECT TOP (1) id FROM chatbase.tags WHERE company_id = ${company} AND is_kanban_column = 0`);
    if (anyTag) s.tagContact = anyTag.id as string;
  }

  const [role] = await sys.run(sql`
    SELECT TOP (1) r.id, r.name, m.id AS membership_id, m.user_id
    FROM chatbase.membership_roles mr
    JOIN chatbase.roles r ON r.id = mr.role_id
    JOIN chatbase.company_memberships m ON m.id = mr.membership_id
    WHERE m.company_id = ${company} AND m.is_active = 1`);
  if (role) {
    s.role = role.id as string;
    s.roleName = role.name as string;
    s.membership = role.membership_id as string;
    s.memberUser = role.user_id as string;
  }

  if (s.conversation !== NIL) {
    const [message] = await sys.run(sql`
      SELECT TOP (1) id, conversation_id, ycloud_message_id FROM chatbase.messages
      WHERE conversation_id = ${s.conversation} AND ycloud_message_id IS NOT NULL
      ORDER BY created_at ASC`);
    if (message) {
      s.message = message.id as string;
      s.messageConversation = message.conversation_id as string;
      s.ycloudMessageId = message.ycloud_message_id as string;
    }
  }
  const [mediaMessage] = await sys.run(sql`
    SELECT TOP (1) id FROM chatbase.messages
    WHERE company_id = ${company} AND media_url IS NOT NULL
    ORDER BY created_at DESC`);
  if (mediaMessage) s.mediaMessage = mediaMessage.id as string;

  const [ticket] = await sys.run(sql`SELECT TOP (1) id FROM chatbase.tickets WHERE company_id = ${company}`);
  if (ticket) s.ticket = ticket.id as string;
  const [note] = await sys.run(sql`
    SELECT TOP (1) conversation_id FROM chatbase.conversation_notes WHERE company_id = ${company}`);
  if (note) s.noteConversation = note.conversation_id as string;
  return s;
}

// ---------------------------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------------------------

type OrderBy = { by: (row: any, side: "sb" | "sql") => unknown; desc?: boolean };

type ReadSpec = {
  fn: string;
  variant?: string;
  /** Same arguments for every company: run once. */
  global?: boolean;
  call: (db: any, s: Seed) => Promise<any>;
  /** Table the row key belongs to, to classify rows on one side only. */
  table?: string;
  key?: string | ((row: any) => string) | null;
  order?: OrderBy[];
  /** Page size when the rows are one window of a longer list. */
  limit?: number;
  /** The page doesn't start at the top of the list. */
  offsetPage?: boolean;
  /** Conversation rows may differ only through what moved on since the copy. */
  related?: (row: any) => Array<[string, unknown]>;
  /** The list depends on conversation_tags, whose changes don't move updated_at. */
  tagLinks?: boolean;
  /** Exact totals can't hold: compare the snapshot of this table restricted to the copy. */
  countOver?: { table: string; where: (row: any, s: Seed) => boolean };
  /** Skip the Supabase side; `lookup` checks the SQL rows by primary key instead. */
  sqlOnly?: { lookup?: { table: string; columns: string } };
  /** Both backends must fail, as this query is broken on Supabase too. */
  bothFail?: boolean;
  /** Skip in the user phase. */
  noUser?: boolean;
};

const byId = (table: string, column: string) => (row: any, side: "sb" | "sql") =>
  snapshots[table][side].get(row.id)?.[column];

const stableWindow = () => new Date(new Date(cutoff).getTime() - 86_400_000).toISOString();
const WINDOW = { ts: "", id: FAR_ID };

function readSpecs(): ReadSpec[] {
  const conv = { table: "conversations", related: RELATED_TO_CONVERSATION };
  const convOrder: OrderBy[] = [{ by: byId("conversations", "last_message_at"), desc: true }];
  const noFilters = { assignee: "all", searchPattern: null, searchContactIds: null };
  return [
    // companies
    { fn: "companies.listCompanyNames", global: true, table: "companies", order: [{ by: (r) => r.name }], call: (db) => R.companies.listCompanyNames(db) },
    { fn: "companies.listCompaniesPage", variant: "all", global: true, table: "companies", order: [{ by: byId("companies", "created_at"), desc: true }], call: (db) => R.companies.listCompaniesPage(db, { status: "all", from: 0, to: 99 }) },
    { fn: "companies.listCompaniesPage", variant: "active+page2", global: true, table: "companies", limit: 2, offsetPage: true, order: [{ by: byId("companies", "created_at"), desc: true }], call: (db) => R.companies.listCompaniesPage(db, { status: "active", from: 2, to: 3 }) },
    { fn: "companies.listCompaniesPage", variant: "inactive", global: true, table: "companies", call: (db) => R.companies.listCompaniesPage(db, { status: "inactive", from: 0, to: 99 }) },
    { fn: "companies.listCompaniesPage", variant: "search", table: "companies", call: (db, s) => R.companies.listCompaniesPage(db, { status: "all", searchPattern: ilikePattern(s.companyGuid.slice(0, 6) || "a"), from: 0, to: 99 }) },
    { fn: "companies.listCompaniesPage", variant: "include", table: "companies", call: (db, s) => R.companies.listCompaniesPage(db, { status: "all", includeIds: [s.company, NIL], from: 0, to: 99 }) },
    { fn: "companies.listCompaniesPage", variant: "exclude", table: "companies", call: (db, s) => R.companies.listCompaniesPage(db, { status: "all", excludeIds: [s.company], from: 0, to: 99 }) },

    // contacts
    { fn: "contacts.listContactTagOptions", global: true, table: "tags", order: [{ by: (r) => r.name }], call: (db) => R.contacts.listContactTagOptions(db) },
    { fn: "contacts.listCompaniesForContactFilter", global: true, table: "companies", order: [{ by: (r) => r.name }], call: (db) => R.contacts.listCompaniesForContactFilter(db) },
    { fn: "contacts.listContactIdsByTag", table: "contacts", key: "contact_id", call: (db, s) => R.contacts.listContactIdsByTag(db, s.tagContact) },
    { fn: "contacts.listContactIdsPage", variant: "company", table: "contacts", limit: 50, order: [{ by: byId("contacts", "created_at"), desc: true }], countOver: { table: "contacts", where: (r, s) => r.company_id === s.company }, call: (db, s) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: [s.company], companyId: "", contactIds: null, q: "", from: 0, to: 49 }) },
    { fn: "contacts.listContactIdsPage", variant: "companyId", table: "contacts", limit: 50, offsetPage: true, order: [{ by: byId("contacts", "created_at"), desc: true }], countOver: { table: "contacts", where: (r, s) => r.company_id === s.company }, call: (db, s) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: null, companyId: s.company, contactIds: null, q: "", from: 50, to: 99 }) },
    { fn: "contacts.listContactIdsPage", variant: "ids", table: "contacts", call: (db, s) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: null, companyId: "", contactIds: [s.contact, s.contactWithTag, NIL], q: "", from: 0, to: 49 }) },
    { fn: "contacts.listContactIdsPage", variant: "search", table: "contacts", limit: 100, order: [{ by: byId("contacts", "created_at"), desc: true }], call: (db, s) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: null, companyId: s.company, contactIds: null, q: s.contactSearch, from: 0, to: 99 }) },
    { fn: "contacts.listContactIdsPage", variant: "digits", table: "contacts", limit: 100, order: [{ by: byId("contacts", "created_at"), desc: true }], call: (db, s) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: null, companyId: s.company, contactIds: null, q: s.digitsSearch, from: 0, to: 99 }) },
    { fn: "contacts.listContactIdsPage", variant: "empty-scope", global: true, table: "contacts", call: (db) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: [], companyId: "", contactIds: null, q: "", from: 0, to: 9 }) },
    { fn: "contacts.listContactsByIds", table: "contacts", related: (r) => [["contacts", r.id]], order: [{ by: byId("contacts", "created_at"), desc: true }], call: (db, s) => R.contacts.listContactsByIds(db, [s.contact, s.contactWithTag]) },

    // conversations
    { fn: "conversations.listConversationsPage", variant: "first-page", global: true, ...conv, limit: 50, order: convOrder, call: (db) => R.conversations.listConversationsPage(db, { limit: 50 }) },
    { fn: "conversations.listConversationsPage", variant: "before-cursor", global: true, ...conv, limit: 200, order: convOrder, call: (db) => R.conversations.listConversationsPage(db, { limit: 200, before: { ...WINDOW, ts: stableWindow() } }) },
    { fn: "conversations.listConversationsPage", variant: "company", ...conv, limit: 100, order: convOrder, call: (db, s) => R.conversations.listConversationsPage(db, { limit: 100, companyId: s.company, before: { ...WINDOW, ts: stableWindow() } }) },
    { fn: "conversations.listConversationsPage", variant: "unassigned", ...conv, limit: 50, order: convOrder, call: (db, s) => R.conversations.listConversationsPage(db, { limit: 50, assignee: "unassigned", companyId: s.company, before: { ...WINDOW, ts: stableWindow() } }) },
    { fn: "conversations.listConversationsPage", variant: "mine", ...conv, limit: 50, order: convOrder, call: (db, s) => R.conversations.listConversationsPage(db, { limit: 50, assignee: "mine", currentUserId: s.assignee, companyId: s.company }) },
    { fn: "conversations.listConversationsPage", variant: "assigneeId", ...conv, limit: 50, order: convOrder, call: (db, s) => R.conversations.listConversationsPage(db, { limit: 50, assigneeId: s.assignee, before: { ...WINDOW, ts: stableWindow() } }) },
    { fn: "conversations.listConversationsPage", variant: "contacts", ...conv, limit: 50, order: convOrder, call: (db, s) => R.conversations.listConversationsPage(db, { limit: 50, contactIds: [s.contact, NIL] }) },
    { fn: "conversations.findConversationForList", ...conv, call: (db, s) => R.conversations.findConversationForList(db, s.conversation) },
    { fn: "conversations.findConversationForList", variant: "none", global: true, ...conv, call: (db) => R.conversations.findConversationForList(db, NIL) },
    { fn: "conversations.searchContactIdsByNameOrPhone", variant: "name", table: "contacts", limit: 500, call: (db, s) => R.conversations.searchContactIdsByNameOrPhone(db, s.contactSearch, "", s.company) },
    { fn: "conversations.searchContactIdsByNameOrPhone", variant: "digits", table: "contacts", limit: 500, call: (db, s) => R.conversations.searchContactIdsByNameOrPhone(db, `+${s.digitsSearch}`, s.digitsSearch) },
    { fn: "conversations.listContactIdsByTag", table: "contacts", key: "contact_id", limit: 2000, call: (db, s) => R.conversations.listContactIdsByTag(db, s.tagContact) },
    { fn: "conversations.findConversationAssignee", key: null, call: (db, s) => R.conversations.findConversationAssignee(db, s.conversationAssigned) },
    { fn: "conversations.findConversationAssignee", variant: "none", global: true, key: null, call: (db) => R.conversations.findConversationAssignee(db, NIL) },
    { fn: "conversations.listConversationsAssignedTo", ...conv, limit: 500, call: (db, s) => R.conversations.listConversationsAssignedTo(db, s.assignee) },
    { fn: "conversations.getConversationCompany", ...conv, call: (db, s) => R.conversations.getConversationCompany(db, s.conversation) },
    { fn: "conversations.getConversationCompany", variant: "none", global: true, ...conv, call: (db) => R.conversations.getConversationCompany(db, NIL) },
    { fn: "conversations.findActiveMembershipWithRole", table: "company_memberships", call: (db, s) => R.conversations.findActiveMembershipWithRole(db, s.memberUser, s.company, s.roleName) },
    { fn: "conversations.findActiveMembershipWithRole", variant: "other-case", table: "company_memberships", call: (db, s) => R.conversations.findActiveMembershipWithRole(db, s.memberUser, s.company, s.roleName.toUpperCase()) },
    { fn: "conversations.listConversationTagsWithKanbanFlag", table: "tags", key: "tag_id", call: (db, s) => R.conversations.listConversationTagsWithKanbanFlag(db, s.conversation) },
    { fn: "conversations.findInboxForNewConversation", table: "inboxes", call: (db, s) => R.conversations.findInboxForNewConversation(db, s.inbox) },
    { fn: "conversations.findInboxForNewConversation", variant: "none", global: true, table: "inboxes", call: (db) => R.conversations.findInboxForNewConversation(db, NIL) },
    { fn: "conversations.listCompaniesByName", global: true, table: "companies", order: [{ by: (r) => r.name }], call: (db) => R.conversations.listCompaniesByName(db) },
    { fn: "conversations.listKanbanTagOptions", global: true, table: "tags", call: (db) => R.conversations.listKanbanTagOptions(db) },
    { fn: "conversations.listContactTagOptions", global: true, table: "tags", order: [{ by: (r) => r.name }], call: (db) => R.conversations.listContactTagOptions(db) },
    { fn: "conversations.findCompanyByGuid", table: "companies", call: (db, s) => R.conversations.findCompanyByGuid(db, s.companyGuid || "none") },
    { fn: "conversations.findCompanyByGuid", variant: "other-case", table: "companies", call: (db, s) => R.conversations.findCompanyByGuid(db, (s.companyGuid || "none").toUpperCase()) },
    { fn: "conversations.findCompanyById", table: "companies", call: (db, s) => R.conversations.findCompanyById(db, s.company) },
    { fn: "conversations.listContactsByPhoneNumbers", table: "contacts", limit: 5, call: (db, s) => R.conversations.listContactsByPhoneNumbers(db, s.company, [s.contactPhone, `no${s.contactPhone}`]) },
    { fn: "conversations.listLatestConversationOfContacts", ...conv, limit: 1, order: convOrder, call: (db, s) => R.conversations.listLatestConversationOfContacts(db, s.company, [s.contact, NIL]) },

    // dashboard
    { fn: "dashboard.listDashboardInboxes", variant: "all", global: true, table: "inboxes", call: (db) => R.dashboard.listDashboardInboxes(db, null) },
    { fn: "dashboard.listDashboardInboxes", variant: "filter", table: "inboxes", call: (db, s) => R.dashboard.listDashboardInboxes(db, `company_id.in.(${s.company}),id.in.(${s.inbox})`) },
    { fn: "dashboard.listInboxNamesByIds", table: "inboxes", call: (db, s) => R.dashboard.listInboxNamesByIds(db, [s.inbox, NIL]) },
    { fn: "dashboard.countCompanies", global: true, call: (db) => R.dashboard.countCompanies(db) },
    { fn: "dashboard.countOpenConversations", variant: "all", global: true, countOver: { table: "conversations", where: (r) => r.status === "open" }, call: (db) => R.dashboard.countOpenConversations(db, null) },
    { fn: "dashboard.countOpenConversations", variant: "inboxes", countOver: { table: "conversations", where: (r, s) => r.status === "open" && s.inboxes.includes(r.inbox_id) }, call: (db, s) => R.dashboard.countOpenConversations(db, s.inboxes) },
    { fn: "dashboard.countOpenConversations", variant: "empty", global: true, call: (db) => R.dashboard.countOpenConversations(db, []) },
    { fn: "dashboard.countUnassignedOpenConversations", variant: "all", global: true, countOver: { table: "conversations", where: (r) => r.status === "open" && !r.assignee_id }, call: (db) => R.dashboard.countUnassignedOpenConversations(db, null) },
    { fn: "dashboard.countUnassignedOpenConversations", variant: "inboxes", countOver: { table: "conversations", where: (r, s) => r.status === "open" && !r.assignee_id && s.inboxes.includes(r.inbox_id) }, call: (db, s) => R.dashboard.countUnassignedOpenConversations(db, s.inboxes) },
    { fn: "dashboard.countConversationsInsideWindow", variant: "all", global: true, countOver: { table: "conversations", where: (r) => r.window_expires_at && instant(r.window_expires_at)! > instant(cutoff)! }, call: (db) => R.dashboard.countConversationsInsideWindow(db, cutoff, null) },
    { fn: "dashboard.countConversationsInsideWindow", variant: "inboxes", countOver: { table: "conversations", where: (r, s) => r.window_expires_at && instant(r.window_expires_at)! > instant(cutoff)! && s.inboxes.includes(r.inbox_id) }, call: (db, s) => R.dashboard.countConversationsInsideWindow(db, cutoff, s.inboxes) },
    { fn: "dashboard.countConversationsOutsideWindow", variant: "all", global: true, countOver: { table: "conversations", where: (r) => !r.window_expires_at || instant(r.window_expires_at)! <= instant(cutoff)! }, call: (db) => R.dashboard.countConversationsOutsideWindow(db, cutoff, null) },
    { fn: "dashboard.countConversationsOutsideWindow", variant: "inboxes", countOver: { table: "conversations", where: (r, s) => (!r.window_expires_at || instant(r.window_expires_at)! <= instant(cutoff)!) && s.inboxes.includes(r.inbox_id) }, call: (db, s) => R.dashboard.countConversationsOutsideWindow(db, cutoff, s.inboxes) },
    { fn: "dashboard.countOpenConversationsInInbox", countOver: { table: "conversations", where: (r, s) => r.status === "open" && r.inbox_id === s.inbox }, call: (db, s) => R.dashboard.countOpenConversationsInInbox(db, s.inbox) },
    { fn: "dashboard.countTicketsByStatus", variant: "open", global: true, call: (db) => R.dashboard.countTicketsByStatus(db, "open") },
    { fn: "dashboard.countTicketsByStatus", variant: "closed", global: true, call: (db) => R.dashboard.countTicketsByStatus(db, "closed") },
    { fn: "dashboard.countContacts", variant: "all", global: true, countOver: { table: "contacts", where: () => true }, call: (db) => R.dashboard.countContacts(db, null) },
    { fn: "dashboard.countContacts", variant: "company", countOver: { table: "contacts", where: (r, s) => r.company_id === s.company }, call: (db, s) => R.dashboard.countContacts(db, [s.company]) },
    { fn: "dashboard.countContacts", variant: "empty", global: true, call: (db) => R.dashboard.countContacts(db, []) },
    { fn: "dashboard.countMessagesSince", variant: "all-sql-only", global: true, sqlOnly: {}, call: (db) => R.dashboard.countMessagesSince(db, "inbound", new Date(new Date(cutoff).getTime() - 86_400_000).toISOString(), null) },

    // errors
    { fn: "errors.listCompaniesForErrorLogFilter", global: true, table: "companies", order: [{ by: (r) => r.name }], call: (db) => R.errors.listCompaniesForErrorLogFilter(db) },
    { fn: "errors.listErrorLogSources", global: true, key: null, limit: 1000, call: (db) => R.errors.listErrorLogSources(db) },
    { fn: "errors.listErrorLogsPage", variant: "all", global: true, table: "error_logs", order: [{ by: (r) => instant(r.created_at), desc: true }], call: (db) => R.errors.listErrorLogsPage(db, { companyId: "all", status: "all", level: "all", source: "all", q: "", from: 0, to: 199 }) },
    { fn: "errors.listErrorLogsPage", variant: "page", global: true, table: "error_logs", limit: 10, offsetPage: true, order: [{ by: (r) => instant(r.created_at), desc: true }], call: (db) => R.errors.listErrorLogsPage(db, { companyId: "all", status: "all", level: "all", source: "all", q: "", from: 10, to: 19 }) },
    { fn: "errors.listErrorLogsPage", variant: "none-company", global: true, table: "error_logs", call: (db) => R.errors.listErrorLogsPage(db, { companyId: "none", status: "all", level: "all", source: "all", q: "", from: 0, to: 199 }) },
    { fn: "errors.listErrorLogsPage", variant: "company", table: "error_logs", call: (db, s) => R.errors.listErrorLogsPage(db, { companyId: s.company, status: "all", level: "all", source: "all", q: "", from: 0, to: 199 }) },
    { fn: "errors.listErrorLogsPage", variant: "status", global: true, table: "error_logs", call: (db) => R.errors.listErrorLogsPage(db, { companyId: "all", status: "open", level: "error", source: "all", q: "", from: 0, to: 199 }) },
    { fn: "errors.listErrorLogsPage", variant: "search", global: true, table: "error_logs", call: (db) => R.errors.listErrorLogsPage(db, { companyId: "all", status: "all", level: "all", source: "all", q: "ERROR", from: 0, to: 199 }) },

    // inboxes
    { fn: "inboxes.listCompanyInboxIds", table: "inboxes", call: (db, s) => R.inboxes.listCompanyInboxIds(db, s.company) },
    { fn: "inboxes.listInboxCompaniesByIds", table: "inboxes", call: (db, s) => R.inboxes.listInboxCompaniesByIds(db, s.inboxes) },
    { fn: "inboxes.listActiveCompanyInboxIds", table: "inboxes", call: (db, s) => R.inboxes.listActiveCompanyInboxIds(db, s.company, s.inboxes) },
    { fn: "inboxes.listActiveAssignedInboxes", global: true, table: "inboxes", call: (db) => R.inboxes.listActiveAssignedInboxes(db) },
    { fn: "inboxes.listInboxNamesByIds", table: "inboxes", call: (db, s) => R.inboxes.listInboxNamesByIds(db, s.inboxes) },
    { fn: "inboxes.listAllInboxes", global: true, table: "inboxes", order: [{ by: (r) => r.name }], call: (db) => R.inboxes.listAllInboxes(db) },
    { fn: "inboxes.listInboxesPage", variant: "all", global: true, table: "inboxes", order: [{ by: byId("inboxes", "created_at"), desc: true }], call: (db) => R.inboxes.listInboxesPage(db, { status: "all", from: 0, to: 99 }) },
    { fn: "inboxes.listInboxesPage", variant: "active", global: true, table: "inboxes", call: (db) => R.inboxes.listInboxesPage(db, { status: "active", from: 0, to: 99 }) },
    { fn: "inboxes.listInboxesPage", variant: "none-company", global: true, table: "inboxes", call: (db) => R.inboxes.listInboxesPage(db, { status: "all", companyId: "none", from: 0, to: 99 }) },
    { fn: "inboxes.listInboxesPage", variant: "company", table: "inboxes", call: (db, s) => R.inboxes.listInboxesPage(db, { status: "all", companyId: s.company, from: 0, to: 99 }) },
    { fn: "inboxes.listInboxesPage", variant: "search", table: "inboxes", call: (db, s) => R.inboxes.listInboxesPage(db, { status: "all", searchPattern: ilikePattern(s.digitsSearch ? "a" : "e"), from: 0, to: 99 }) },

    // kanban
    { fn: "kanban.searchKanbanContactIds", table: "contacts", call: (db, s) => R.kanban.searchKanbanContactIds(db, s.company, ilikePattern(s.contactSearch)) },
    { fn: "kanban.listTaggedConversationIds", variant: "plain", ...conv, tagLinks: true, limit: 200, order: convOrder, call: (db, s) => R.kanban.listTaggedConversationIds(db, s.company, s.tagKanban, noFilters, 0, 199) },
    { fn: "kanban.listTaggedConversationIds", variant: "inbox+unassigned", ...conv, tagLinks: true, limit: 50, order: convOrder, call: (db, s) => R.kanban.listTaggedConversationIds(db, s.company, s.tagKanban, { ...noFilters, inboxId: s.inbox, assignee: "unassigned" }, 0, 49) },
    { fn: "kanban.listTaggedConversationIds", variant: "mine", ...conv, tagLinks: true, limit: 50, order: convOrder, call: (db, s) => R.kanban.listTaggedConversationIds(db, s.company, s.tagKanban, { ...noFilters, assignee: "mine", userId: s.assignee }, 0, 49) },
    { fn: "kanban.listTaggedConversationIds", variant: "search", ...conv, tagLinks: true, limit: 50, order: convOrder, call: (db, s) => R.kanban.listTaggedConversationIds(db, s.company, s.tagKanban, { ...noFilters, searchPattern: ilikePattern(s.contactSearch), searchContactIds: [s.contact] }, 0, 49) },
    { fn: "kanban.listKanbanColumnIds", table: "tags", call: (db, s) => R.kanban.listKanbanColumnIds(db, s.company) },
    { fn: "kanban.listUntaggedConversationIds", variant: "plain", ...conv, tagLinks: true, limit: 100, order: convOrder, call: (db, s) => R.kanban.listUntaggedConversationIds(db, s.company, [s.tagKanban], noFilters, 0, 99) },
    { fn: "kanban.listUntaggedConversationIds", variant: "search", ...conv, tagLinks: true, limit: 50, order: convOrder, call: (db, s) => R.kanban.listUntaggedConversationIds(db, s.company, [s.tagKanban], { ...noFilters, searchPattern: ilikePattern(s.contactSearch) }, 0, 49) },
    { fn: "kanban.listKanbanCardRows", ...conv, order: [{ by: (r) => instant(r.last_message_at), desc: true }], call: (db, s) => R.kanban.listKanbanCardRows(db, [s.conversation, s.conversationAssigned]) },
    { fn: "kanban.listKanbanInboxes", variant: "all", global: true, table: "inboxes", call: (db) => R.kanban.listKanbanInboxes(db) },
    { fn: "kanban.listKanbanInboxes", variant: "company", table: "inboxes", call: (db, s) => R.kanban.listKanbanInboxes(db, s.company) },
    { fn: "kanban.listKanbanColumns", variant: "all", global: true, table: "tags", call: (db) => R.kanban.listKanbanColumns(db) },
    { fn: "kanban.listKanbanColumns", variant: "company", table: "tags", order: [{ by: (r) => r.position }], call: (db, s) => R.kanban.listKanbanColumns(db, s.company) },

    // media
    { fn: "media.findMessageMedia", table: "messages", call: (db, s) => R.media.findMessageMedia(db, s.mediaMessage) },
    { fn: "media.findMessageMedia", variant: "none", global: true, table: "messages", call: (db) => R.media.findMessageMedia(db, NIL) },

    // memberships
    { fn: "memberships.listActiveMembersByRoleName", variant: "company", key: (r) => `${r.company_id}:${r.profiles?.id}`, call: (db, s) => R.memberships.listActiveMembersByRoleName(db, s.roleName, s.company) },
    { fn: "memberships.listActiveMembersByRoleName", variant: "all", global: true, key: (r) => `${r.company_id}:${r.profiles?.id}`, call: (db) => R.memberships.listActiveMembersByRoleName(db, "Agente") },
    { fn: "memberships.listActiveMembersByRoleName", variant: "other-case", global: true, key: (r) => `${r.company_id}:${r.profiles?.id}`, call: (db) => R.memberships.listActiveMembersByRoleName(db, "AGENTE") },
    { fn: "memberships.listActiveMembershipsForSession", table: "company_memberships", call: (db, s) => R.memberships.listActiveMembershipsForSession(db, s.memberUser) },
    { fn: "memberships.listMembershipsPage", variant: "all", global: true, table: "company_memberships", order: [{ by: byId("company_memberships", "created_at"), desc: true }], call: (db) => R.memberships.listMembershipsPage(db, { status: "all", from: 0, to: 99 }) },
    { fn: "memberships.listMembershipsPage", variant: "company", table: "company_memberships", call: (db, s) => R.memberships.listMembershipsPage(db, { companyId: s.company, status: "active", from: 0, to: 99 }) },
    { fn: "memberships.listMembershipsPage", variant: "inactive", global: true, table: "company_memberships", call: (db) => R.memberships.listMembershipsPage(db, { status: "inactive", from: 0, to: 99 }) },
    { fn: "memberships.listMembershipsPage", variant: "users", table: "company_memberships", call: (db, s) => R.memberships.listMembershipsPage(db, { status: "all", userIds: [s.memberUser], from: 0, to: 99 }) },
    { fn: "memberships.listMembershipsPage", variant: "ids", table: "company_memberships", call: (db, s) => R.memberships.listMembershipsPage(db, { status: "all", membershipIds: [s.membership], from: 0, to: 99 }) },
    { fn: "memberships.listMembershipsPage", variant: "empty-ids", global: true, table: "company_memberships", call: (db) => R.memberships.listMembershipsPage(db, { status: "all", userIds: [], from: 0, to: 99 }) },
    { fn: "memberships.listCompanyMembershipIds", table: "company_memberships", call: (db, s) => R.memberships.listCompanyMembershipIds(db, s.company) },
    { fn: "memberships.findCompanyMembership", table: "company_memberships", call: (db, s) => R.memberships.findCompanyMembership(db, s.membership, s.company, s.memberUser) },
    { fn: "memberships.listMembershipIdsByRole", table: "company_memberships", key: "membership_id", call: (db, s) => R.memberships.listMembershipIdsByRole(db, s.role) },

    // messages
    { fn: "messages.listConversationMessagesPage", variant: "first", table: "messages", order: [{ by: (r) => instant(r.created_at), desc: true }], limit: 25, call: (db, s) => R.messages.listConversationMessagesPage(db, s.conversation) },
    { fn: "messages.listConversationMessagesPage", variant: "assigned", table: "messages", order: [{ by: (r) => instant(r.created_at), desc: true }], limit: 25, call: (db, s) => R.messages.listConversationMessagesPage(db, s.conversationAssigned) },
    { fn: "messages.listInboundMessagesAfter", global: true, sqlOnly: { lookup: { table: "messages", columns: "id, conversation_id, body, created_at, direction" } }, order: [{ by: (r) => instant(r.created_at) }], call: (db) => R.messages.listInboundMessagesAfter(db, new Date(new Date(cutoff).getTime() - 7 * 86_400_000).toISOString()) },

    // messaging
    { fn: "messaging.getConversationForSending", ...conv, call: (db, s) => R.messaging.getConversationForSending(db, s.conversation) },
    { fn: "messaging.getConversationForSending", variant: "none", global: true, ...conv, call: (db) => R.messaging.getConversationForSending(db, NIL) },
    { fn: "messaging.getConversationForSofia", ...conv, call: (db, s) => R.messaging.getConversationForSofia(db, s.conversation) },
    { fn: "messaging.getConversationInbox", key: null, call: (db, s) => R.messaging.getConversationInbox(db, s.conversation) },
    { fn: "messaging.getConversationInbox", variant: "none", global: true, key: null, call: (db) => R.messaging.getConversationInbox(db, NIL) },
    { fn: "messaging.findConversationInbox", key: null, call: (db, s) => R.messaging.findConversationInbox(db, s.conversation) },
    { fn: "messaging.findConversationInbox", variant: "none", global: true, key: null, call: (db) => R.messaging.findConversationInbox(db, NIL) },
    { fn: "messaging.findInboxId", table: "inboxes", call: (db, s) => R.messaging.findInboxId(db, s.inbox) },
    { fn: "messaging.findCompanyGuid", key: null, call: (db, s) => R.messaging.findCompanyGuid(db, s.company) },
    { fn: "messaging.getMessageForReaction", table: "messages", call: (db, s) => R.messaging.getMessageForReaction(db, s.message, s.messageConversation) },
    { fn: "messaging.getMessageForReaction", variant: "wrong-conversation", global: true, table: "messages", call: (db, s) => R.messaging.getMessageForReaction(db, s.message, NIL) },
    { fn: "messaging.listEnrichableMessagesByYCloudIds", table: "messages", limit: 1, call: (db, s) => R.messaging.listEnrichableMessagesByYCloudIds(db, [s.ycloudMessageId, `no-${s.ycloudMessageId}`]) },

    // notes
    { fn: "notes.listConversationNotes", table: "conversation_notes", order: [{ by: (r) => instant(r.created_at), desc: true }], call: (db, s) => R.notes.listConversationNotes(db, s.noteConversation) },

    // profiles
    { fn: "profiles.getSessionProfile", table: "profiles", call: (db, s) => R.profiles.getSessionProfile(db, s.memberUser) },
    { fn: "profiles.getSessionProfile", variant: "none", global: true, table: "profiles", call: (db) => R.profiles.getSessionProfile(db, NIL) },
    { fn: "profiles.searchProfileIds", variant: "e", global: true, table: "profiles", call: (db) => R.profiles.searchProfileIds(db, "%e%") },
    { fn: "profiles.searchProfileIds", variant: "upper", global: true, table: "profiles", call: (db) => R.profiles.searchProfileIds(db, "%COM%") },
    { fn: "profiles.searchProfileIds", variant: "star", global: true, table: "profiles", call: (db) => R.profiles.searchProfileIds(db, "*a*") },
    { fn: "profiles.searchProfileIds", variant: "bracket", global: true, table: "profiles", call: (db) => R.profiles.searchProfileIds(db, "%[a]%") },
    { fn: "profiles.searchProfileIds", variant: "underscore", global: true, table: "profiles", call: (db) => R.profiles.searchProfileIds(db, "%_%") },

    // roles
    { fn: "roles.listTemplateRolesWithPermissions", global: true, table: "roles", call: (db) => R.roles.listTemplateRolesWithPermissions(db) },
    { fn: "roles.findCompanyRole", table: "roles", call: (db, s) => R.roles.findCompanyRole(db, s.role, s.company) },
    { fn: "roles.listCompanyRoles", global: true, table: "roles", call: (db) => R.roles.listCompanyRoles(db) },
    { fn: "roles.listCompanyRolesPage", variant: "all", global: true, table: "roles", order: [{ by: (r) => r.name }], call: (db) => R.roles.listCompanyRolesPage(db, { from: 0, to: 99 }) },
    { fn: "roles.listCompanyRolesPage", variant: "company", table: "roles", order: [{ by: (r) => r.name }], call: (db, s) => R.roles.listCompanyRolesPage(db, { companyId: s.company, from: 0, to: 99 }) },
    { fn: "roles.listCompanyRolesPage", variant: "name", global: true, table: "roles", order: [{ by: (r) => r.name }], call: (db) => R.roles.listCompanyRolesPage(db, { namePattern: "%agente%", from: 0, to: 99 }) },
    { fn: "roles.listPermissions", global: true, key: "code", order: [{ by: (r) => r.code }], call: (db) => R.roles.listPermissions(db) },
    { fn: "roles.listPermissionsByCodes", global: true, table: "permissions", call: (db) => R.roles.listPermissionsByCodes(db, ["conversations.view", "tickets.manage", "CONVERSATIONS.VIEW", "nope"]) },
    { fn: "roles.listRolePermissionCodes", key: null, call: (db, s) => R.roles.listRolePermissionCodes(db, s.role) },
    { fn: "roles.listRolePermissionRows", key: null, bothFail: true, call: (db, s) => R.roles.listRolePermissionRows(db, s.role) },

    // storage
    { fn: "storage.downloadStorageObject", global: true, key: null, noUser: true, bothFail: true, call: (db) => R.storage.downloadStorageObject(db, "chat-media", "prueba-migracion-repos/no-existe.bin") },

    // tags
    { fn: "tags.listCompanyContactTagIds", table: "tags", call: (db, s) => R.tags.listCompanyContactTagIds(db, s.company, [s.tagContact, s.tagKanban, NIL]) },
    { fn: "tags.getContactCompanyId", table: "contacts", call: (db, s) => R.tags.getContactCompanyId(db, s.contact) },

    // tickets
    { fn: "tickets.listTicketsPage", variant: "all", global: true, table: "tickets", order: [{ by: (r) => instant(r.created_at), desc: true }], call: (db) => R.tickets.listTicketsPage(db, { status: "all", priority: "all" }, 0, 99) },
    { fn: "tickets.listTicketsPage", variant: "open", global: true, table: "tickets", call: (db) => R.tickets.listTicketsPage(db, { status: "open", priority: "all" }, 0, 99) },
    { fn: "tickets.listTicketsPage", variant: "unassigned", global: true, table: "tickets", call: (db) => R.tickets.listTicketsPage(db, { status: "all", priority: "all", unassignedOnly: true }, 0, 99) },
    { fn: "tickets.listTicketsPage", variant: "created-by", table: "tickets", call: (db, s) => R.tickets.listTicketsPage(db, { status: "all", priority: "all", createdBy: s.memberUser }, 0, 99) },
    { fn: "tickets.listTicketsPage", variant: "search", global: true, table: "tickets", call: (db) => R.tickets.listTicketsPage(db, { status: "all", priority: "all", search: "a" }, 0, 99) },
    { fn: "tickets.getTicketOwnership", table: "tickets", call: (db, s) => R.tickets.getTicketOwnership(db, s.ticket) },

    // ycloud
    { fn: "ycloud.listYCloudAccounts", global: true, table: "ycloud_accounts", order: [{ by: (r) => r.id }], call: (db) => R.ycloud.listYCloudAccounts(db) },
    { fn: "ycloud.findYCloudAccount", key: null, table: "ycloud_accounts", call: (db, s) => accountOf(s).then((id) => R.ycloud.findYCloudAccount(db, id)) },
    { fn: "ycloud.findYCloudAccountName", key: null, table: "ycloud_accounts", call: (db, s) => accountOf(s).then((id) => R.ycloud.findYCloudAccountName(db, id)) },
    { fn: "ycloud.findInboxForCredentials", table: "inboxes", call: (db, s) => R.ycloud.findInboxForCredentials(db, s.inbox) },
    { fn: "ycloud.listInboxesForPhoneSync", global: true, table: "inboxes", call: (db) => R.ycloud.listInboxesForPhoneSync(db) },
  ];
}

async function accountOf(s: Seed) {
  const [row] = await sys.run(sql`SELECT ycloud_account_id FROM chatbase.inboxes WHERE id = ${s.inbox}`);
  return (row?.ycloud_account_id as string) ?? NIL;
}

const specName = (spec: ReadSpec) => (spec.variant ? `${spec.fn}#${spec.variant}` : spec.fn);

function keyFn(spec: ReadSpec): (row: any) => string {
  const key = spec.key === undefined ? "id" : spec.key;
  if (key === null) return (row) => canonical(row);
  return typeof key === "function" ? key : (row) => String(row[key]);
}

async function compareRows(spec: ReadSpec, sbRows: any[], sqlRows: any[]) {
  const name = specName(spec);
  const keyOf = keyFn(spec);

  // Rows with no identity of their own, such as a list of sources, compare as a multiset.
  if (spec.key === null && !spec.table) {
    const a = sbRows.map(canonical).sort();
    const b = sqlRows.map(canonical).sort();
    if (a.length !== b.length) fail(name, `${a.length} rows vs ${b.length}`);
    else if (a.some((value, i) => value !== b[i])) {
      const diffs: Diff[] = [];
      deepDiff(sbRows, sqlRows, "", diffs);
      for (const diff of diffs) fail(name, `${diff.path}: ${diff.kind}`);
    }
    return;
  }

  const sbMap = new Map(sbRows.map((row) => [keyOf(row), row]));
  const sqlMap = new Map(sqlRows.map((row) => [keyOf(row), row]));
  if (sbMap.size !== sbRows.length) fail(name, "duplicate keys on supabase");
  if (sqlMap.size !== sqlRows.length) fail(name, "duplicate keys on sqlserver");

  const related = (row: any): Array<[string, unknown]> =>
    spec.related ? spec.related(row) : spec.table ? [[spec.table, row[typeof spec.key === "string" ? spec.key : "id"]]] : [];

  const movedOn = async (row: any) => {
    const links = related(row);
    for (const [table, id] of links) await refreshSnapshot(table, id);
    return links.some(([table, id]) => changedSinceCopy(table, id));
  };

  const sortKey = (row: any, side: "sb" | "sql") =>
    JSON.stringify(spec.order?.map((o) => {
      const value = o.by(row, side);
      return instant(value) ?? value ?? null;
    }));
  // On one side only because it ties with the row at the other page's edge: the ties may cut either way.
  const tiedAtEdge = (row: any, side: "sb" | "sql", otherRows: any[], otherSide: "sb" | "sql") => {
    if (!spec.order || !otherRows.length) return false;
    const mine = sortKey(row, side);
    return mine === sortKey(otherRows[0], otherSide) || mine === sortKey(otherRows[otherRows.length - 1], otherSide);
  };

  // A row missing from a full page has to sort past that page's edge, or the page dropped it.
  const pastEdge = (row: any, side: "sb" | "sql", page: any[], pageSide: "sb" | "sql") => {
    const first = spec.order?.[0];
    if (!first || !page.length) return true;
    const sortable = (r: any, s: "sb" | "sql") => {
      const value = first.by(r, s);
      return instant(value) ?? value;
    };
    const mine = sortable(row, side);
    const last = sortable(page[page.length - 1], pageSide);
    const top = sortable(page[0], pageSide);
    if (typeof mine !== "number" || typeof last !== "number") return true;
    const after = first.desc ? mine <= last : mine >= last;
    const before = spec.offsetPage && typeof top === "number" && (first.desc ? mine >= top : mine <= top);
    return after || before;
  };

  for (const [key, row] of sbMap) {
    if (sqlMap.has(key)) continue;
    const id = String(row[typeof spec.key === "string" ? spec.key : "id"]);
    if (!spec.table) {
      fail(name, `row only on supabase (${hash(key)})`);
    } else if (!(await existsOnSql(spec.table, id))) {
      explain("row absent from copy (older or newer)");
    } else if (await movedOn(row)) {
      explain("row changed since copy");
    } else if (spec.limit && sqlRows.length >= spec.limit && pastEdge(row, "sb", sqlRows, "sql")) {
      explain("row outside SQL page window");
    } else if (spec.limit && tiedAtEdge(row, "sb", sqlRows, "sql")) {
      explain("row in an exact tie across a page edge");
    } else if (spec.tagLinks && (await tagLinksMoved(id))) {
      explain("conversation's tags changed since copy");
    } else {
      fail(name, `row only on supabase, present in copy (${hash(key)})`);
    }
  }
  for (const [key, row] of sqlMap) {
    if (sbMap.has(key)) continue;
    const id = String(row[typeof spec.key === "string" ? spec.key : "id"]);
    if (!spec.table) {
      fail(name, `row only on sqlserver (${hash(key)})`);
    } else if (!(await existsOnSupabase(spec.table, id))) {
      explain("row deleted on Supabase or a fake row of another test");
    } else if (await movedOn(row)) {
      explain("row changed since copy");
    } else if (spec.limit && sbRows.length >= spec.limit && pastEdge(row, "sql", sbRows, "sb")) {
      explain("row outside Supabase page window");
    } else if (spec.limit && tiedAtEdge(row, "sql", sbRows, "sb")) {
      explain("row in an exact tie across a page edge");
    } else if (spec.tagLinks && (await tagLinksMoved(id))) {
      explain("conversation's tags changed since copy");
    } else {
      fail(name, `row only on sqlserver, present on supabase (${hash(key)})`);
    }
  }

  // Same values on the intersection.
  for (const [key, row] of sbMap) {
    const other = sqlMap.get(key);
    if (other === undefined) continue;
    const diffs: Diff[] = [];
    deepDiff(row, other, "", diffs);
    if (!diffs.length) continue;
    if (await movedOn(row)) {
      explain("row changed since copy");
      continue;
    }
    for (const diff of diffs) fail(name, `${diff.path}: ${diff.kind} (row ${hash(key)})`);
  }

  // Same order among the rows both have, except inside exact ties.
  if (spec.order) {
    const shared = (rows: any[], side: "sb" | "sql") =>
      rows
        .filter((row) => sbMap.has(keyOf(row)) && sqlMap.has(keyOf(row)))
        .filter((row) => !related(row).some(([t, i]) => changedSinceCopy(t, i)))
        .map((row) => JSON.stringify(spec.order!.map((o) => {
          const value = o.by(row, side);
          return instant(value) ?? value ?? null;
        })));
    const a = shared(sbRows, "sb");
    const b = shared(sqlRows, "sql");
    const at = a.findIndex((value, i) => value !== b[i]);
    if (at >= 0) fail(name, `order differs at shared position ${at} of ${a.length}`);
  }
}

async function compareCount(spec: ReadSpec, s: Seed, sbCount: number | null, sqlCount: number | null) {
  const name = specName(spec);
  if (sbCount === null && sqlCount === null) return;
  if (sbCount === sqlCount) return;
  if (spec.countOver) {
    const { table, where } = spec.countOver;
    const snapshot = snapshots[table];
    const matching = (rows: Map<string, any>) =>
      new Set([...rows.values()].filter((row) => where(row, s)).map((row) => row.id as string));
    // Other tests write to the copy too: read it again rather than trust the first snapshot.
    const fresh = await sys.run(sql`SELECT ${raw(SNAPSHOT_COLUMNS[table])} FROM ${raw(`chatbase.${table}`)}`);
    snapshot.sql = new Map(fresh.map((row) => [row.id as string, row]));
    const sqlMatching = matching(snapshot.sql);
    const sbMatching = matching(snapshot.sb);
    // The function agrees with the rows the filter selects on its own side...
    if (sqlCount !== sqlMatching.size) {
      fail(name, `sql count ${sqlCount} but ${sqlMatching.size} rows match the filter`);
    }
    if (Math.abs((sbCount ?? 0) - sbMatching.size) > 10) {
      fail(name, `supabase count ${sbCount} but ${sbMatching.size} rows match the filter`);
    }
    // ... and the two sides differ only by rows the copy lacks or that moved on since.
    let unexplained = 0;
    let absent = 0;
    for (const id of sbMatching) {
      if (sqlMatching.has(id)) continue;
      if (!snapshot.sql.has(id)) absent++;
      else if (!changedSinceCopy(table, id)) unexplained++;
    }
    for (const id of sqlMatching) {
      if (sbMatching.has(id)) continue;
      if (snapshot.sb.has(id) && !changedSinceCopy(table, id)) unexplained++;
    }
    if (unexplained) fail(name, `count: ${unexplained} rows differ without having changed`);
    else explain("count differs by rows absent from copy or changed since", 1);
    void absent;
    return;
  }
  fail(name, `count ${sbCount} vs ${sqlCount}`);
}

async function compareRead(spec: ReadSpec, s: Seed) {
  const name = specName(spec);
  checks++;

  if (spec.sqlOnly) {
    const result = await spec.call(sys, s);
    if (result.error) return fail(name, `sql error ${result.error.code ?? ""}`);
    const lookup = spec.sqlOnly.lookup;
    if (lookup && Array.isArray(result.data) && result.data.length) {
      const ids = result.data.map((row: any) => row.id);
      const { data, error } = await sb.from(lookup.table).select(lookup.columns).in("id", ids);
      if (error) return fail(name, `supabase lookup ${error.code}`);
      const asFound = new Map((data ?? []).map((row: any) => [row.id, row]));
      for (const row of result.data) {
        const diffs: Diff[] = [];
        if (asFound.has(row.id)) deepDiff(asFound.get(row.id), row, "", diffs);
        else explain("row absent from Supabase");
        for (const diff of diffs) fail(name, `${diff.path}: ${diff.kind}`);
      }
      if (spec.order) {
        const keys = result.data.map((row: any) => spec.order![0].by(row, "sql"));
        const sorted = [...keys].sort((a: any, b: any) => a - b);
        if (keys.some((k: unknown, i: number) => k !== sorted[i])) fail(name, "not in ascending order");
      }
    }
    return;
  }

  const sbResult = await spec.call(sb, s);
  const sqlResult = await spec.call(sys, s);

  if (sbResult.error || sqlResult.error) {
    if (sbResult.error && sqlResult.error) {
      if (spec.bothFail) return;
      if (sbResult.error.code === "PGRST116" && sqlResult.error.code === "PGRST116") return;
      return fail(name, `both fail, different codes: ${sbResult.error.code} vs ${sqlResult.error.code}`);
    }
    if (spec.table && (sbResult.error?.code === "PGRST116" || sqlResult.error?.code === "PGRST116")) {
      return explain("single row absent on one side");
    }
    // PostgREST answers 416 to an offset past the end when it also counts; T-SQL gives an empty page.
    if (sbResult.error?.code === "PGRST103" && !sqlResult.error && !sqlResult.data?.length) {
      return explain("offset past the end: PostgREST PGRST103, SQL Server an empty page");
    }
    return fail(name, `only one side fails: supabase=${sbResult.error?.code ?? "ok"} sql=${sqlResult.error?.code ?? "ok"} ${sqlResult.error ? hash(sqlResult.error.message) : ""}`);
  }
  if (spec.bothFail) fail(name, "expected both to fail");

  const a = sbResult.data ?? null;
  const b = sqlResult.data ?? null;
  if (Array.isArray(a) !== Array.isArray(b)) {
    return fail(name, `shape: ${shapeOf(a)} vs ${shapeOf(b)}`);
  }
  if (Array.isArray(a)) await compareRows(spec, a, b);
  else if (a === null || b === null) {
    if (a !== b) await compareRows(spec, a ? [a] : [], b ? [b] : []);
  } else await compareRows(spec, [a], [b]);
  await compareCount(spec, s, sbResult.count ?? null, sqlResult.count ?? null);
}

async function runReads(seeds: Seed[]) {
  section = "reads";
  const only = process.env.COMPARE_ONLY;
  const specs = readSpecs().filter((spec) => !only || specName(spec).includes(only));
  for (const spec of specs) {
    const targets = spec.global ? seeds.slice(0, 1) : seeds;
    for (const seed of targets) {
      try {
        await compareRead(spec, seed);
      } catch (err) {
        fail(specName(spec), `threw ${(err as Error).message.slice(0, 200)}`);
      }
    }
  }

  // messages has no created_at index on Supabase: one small inbox, bounded by the join.
  const name = "dashboard.countMessagesSince#inbox";
  const smallest = await sys.run(sql`
    SELECT TOP (1) c.inbox_id, COUNT(*) AS n FROM chatbase.conversations c
    GROUP BY c.inbox_id ORDER BY n ASC`);
  const since = new Date(new Date(cutoff).getTime() - 3 * 86_400_000).toISOString();
  if (smallest[0] && Number(smallest[0].n) < 200) {
    const inbox = smallest[0].inbox_id as string;
    const sbFn = await R.dashboard.countMessagesSince(sb, "inbound", since, [inbox]);
    const sqlFn = await R.dashboard.countMessagesSince(sys, "inbound", since, [inbox]);
    check(name, "both run", !sbFn.error && !sqlFn.error);
    check(name, "sql count at most supabase's, which has newer messages", (sqlFn.count ?? 0) <= (sbFn.count ?? 0));
    const bounded = await sb
      .from("messages")
      .select("id, conversations!inner(inbox_id)", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gte("created_at", since)
      .lte("created_at", cutoff)
      .eq("conversations.inbox_id", inbox);
    if (bounded.count !== sqlFn.count) {
      explain("message count differs by messages written around the copy");
      notes_.push(`countMessagesSince bounded: supabase ${bounded.count} vs sql ${sqlFn.count}`);
    }
    const none = await R.dashboard.countMessagesSince(sys, "inbound", since, []);
    check(name, "empty inbox list counts nothing", none.count === 0);
  } else {
    notes_.push("countMessagesSince: no small inbox for the Supabase side");
    await R.dashboard.countMessagesSince(sys, "inbound", since, []);
  }
}

// ---------------------------------------------------------------------------------------------
// User scope.
// ---------------------------------------------------------------------------------------------

type TestUser = { label: string; id: string | null; company: string | null };

async function pickUsers(seeds: Seed[]): Promise<TestUser[]> {
  const [admin] = await sys.run(sql`SELECT TOP (1) id FROM chatbase.profiles WHERE is_platform_admin = 1`);
  const companiesWithData = seeds.filter((s) => s.conversation !== NIL).map((s) => s.company);
  const byRole = async (role: string, not: string[]) => {
    const found = await sys.run(sql`
      SELECT m.user_id, m.company_id
      FROM chatbase.company_memberships m
      JOIN chatbase.membership_roles mr ON mr.membership_id = m.id
      JOIN chatbase.roles r ON r.id = mr.role_id
      JOIN chatbase.profiles p ON p.id = m.user_id
      WHERE r.name = ${role} AND m.is_active = 1 AND p.is_platform_admin = 0`);
    return (
      found.find((row) => companiesWithData.includes(row.company_id as string) && !not.includes(row.company_id as string)) ??
      found.find((row) => !not.includes(row.company_id as string)) ??
      found[0]
    );
  };
  const companyAdmin = await byRole("Admin", []);
  const agent = await byRole("Agente", [companyAdmin.company_id as string]);
  return [
    { label: "platform-admin", id: admin.id as string, company: null },
    { label: "company-admin", id: companyAdmin.user_id as string, company: companyAdmin.company_id as string },
    { label: "agent", id: agent.user_id as string, company: agent.company_id as string },
    { label: "anonymous", id: null, company: null },
  ];
}

async function rowAllowed(table: string | undefined, id: string, access: Access): Promise<boolean> {
  if (!table) return true;
  if (access.isPlatformAdmin) return table !== "ycloud_accounts";
  const snapshot = snapshots[table];
  if (snapshot && !snapshot.sql.has(id)) {
    const [fresh] = await sys.run(sql`
      SELECT ${raw(SNAPSHOT_COLUMNS[table])} FROM ${raw(`chatbase.${table}`)} WHERE id = ${id}`);
    if (fresh) snapshot.sql.set(id, fresh);
  }
  const row = snapshot?.sql.get(id);
  switch (table) {
    case "companies":
      return hasCompanyAccess(access, id);
    case "contacts":
    case "tags":
    case "company_memberships":
      return row ? hasCompanyAccess(access, row.company_id) : false;
    case "conversations":
      return row
        ? inboxesWithPermission(access, "conversations.view").includes(row.inbox_id)
        : false;
    case "inboxes":
      return row
        ? access.isPlatformAdmin ||
            access.inboxIds.includes(id) ||
            hasPermission(access, row.company_id, "inboxes.manage")
        : false;
    case "tickets":
      return row
        ? hasPermission(access, row.company_id, "tickets.view") ||
            hasPermission(access, row.company_id, "tickets.manage")
        : false;
    case "error_logs":
      return (
        access.isPlatformAdmin ||
        [...access.permissionsByCompany.values()].some((held) => held.has("error_logs.view"))
      );
    case "roles":
      return row ? !row.company_id || hasCompanyAccess(access, row.company_id) : false;
    case "ycloud_accounts":
      return false;
    default:
      return true;
  }
}

function companyIdsIn(value: unknown, out: Set<string> = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => companyIdsIn(item, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "company_id" && typeof v === "string") out.add(v);
      else companyIdsIn(v, out);
    }
  }
  return out;
}

async function runUsers(seeds: Seed[]) {
  section = "users";
  const specs = readSpecs();
  const users = await pickUsers(seeds);
  const summary: Record<string, { calls: number; withRows: number; empty: number; hiddenEmbeds: number }> = {};
  const hiddenPaths = new Map<string, number>();

  for (const user of users) {
    const db = userSqlDb(user.id);
    const access = (await accessOf(db))!;
    const stats = (summary[user.label] = { calls: 0, withRows: 0, empty: 0, hiddenEmbeds: 0 });
    const own = seeds.find((s) => s.company === user.company) ?? seeds[0];
    const other = seeds.find((s) => s.company !== own.company) ?? seeds[seeds.length - 1];

    for (const spec of specs) {
      if (spec.noUser) continue;
      const name = `${specName(spec)}@${user.label}`;
      const argSets: Array<[string, Seed]> = spec.global ? [["own", own]] : [["own", own], ["other", other]];
      for (const [which, seed] of argSets) {
        checks++;
        stats.calls++;
        let result: any;
        try {
          result = await spec.call(db, seed);
        } catch (err) {
          fail(name, `threw ${(err as Error).message.slice(0, 200)}`);
          continue;
        }
        if (result.error) {
          const expected =
            result.error.code === "PGRST116" || spec.bothFail;
          if (!expected) fail(name, `${which}: error ${result.error.code ?? hash(result.error.message)}`);
          stats.empty++;
          continue;
        }
        if (spec.bothFail) {
          fail(name, "expected to fail as on Supabase");
          continue;
        }
        const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
        const count: number | null = result.count ?? null;
        if (rows.length || count) stats.withRows++;
        else stats.empty++;

        if (user.id === null) {
          if (rows.length) fail(name, `anonymous got ${rows.length} rows`);
          if (count) fail(name, `anonymous counted ${count}`);
          continue;
        }

        // Every row, and every company_id inside it, within reach.
        const keyOf = keyFn(spec);
        for (const row of rows) {
          const id = String(row[typeof spec.key === "string" ? spec.key : "id"]);
          if (spec.table && spec.key !== null && !(await rowAllowed(spec.table, id, access))) {
            fail(name, `${which}: row outside the user's reach (${hash(id)})`);
          }
        }
        if (!access.isPlatformAdmin) {
          for (const company of companyIdsIn(rows)) {
            if (!hasCompanyAccess(access, company)) fail(name, `${which}: row of another company`);
          }
        }

        // A user's row says what the system's says, except for embeds RLS hides.
        if (!spec.limit && !spec.sqlOnly && spec.key !== null) {
          const system = await spec.call(sys, seed);
          const systemRows: any[] = Array.isArray(system.data) ? system.data : system.data ? [system.data] : [];
          const systemMap = new Map(systemRows.map((row) => [keyOf(row), row]));
          for (const row of rows) {
            const twin = systemMap.get(keyOf(row));
            if (!twin) {
              if (typeof spec.key !== "function") fail(name, `${which}: row the system call doesn't return`);
              continue;
            }
            const diffs: Diff[] = [];
            deepDiff(twin, row, "", diffs);
            for (const diff of diffs) {
              const hidden = / vs null$/.test(diff.kind) || /^array\(\d+\) vs array\(\d+\)$/.test(diff.kind);
              if (hidden) {
                stats.hiddenEmbeds++;
                const where = `${spec.fn} ${diff.path} @${user.label}`;
                hiddenPaths.set(where, (hiddenPaths.get(where) ?? 0) + 1);
              }
              else fail(name, `${which}: ${diff.path}: ${diff.kind}`);
            }
          }
        }
      }
    }
  }
  console.log("users", JSON.stringify(summary));
  for (const [where, n] of hiddenPaths) console.log(`  hidden embed ${n}x: ${where}`);
}

// ---------------------------------------------------------------------------------------------
// The writes, on fake rows only.
// ---------------------------------------------------------------------------------------------

const PREFIX = "prueba-migracion-repos-";
const OLD = "2001-01-01T00:00:00.000Z";

async function cleanup() {
  const run = (statement: any) => sys.run(statement);
  await run(sql`
    DELETE c FROM chatbase.conversations c
    WHERE c.company_id IN (SELECT id FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`})
       OR c.inbox_id IN (SELECT id FROM chatbase.inboxes WHERE name LIKE ${`${PREFIX}%`})`);
  await run(sql`
    DELETE t FROM chatbase.tags t
    WHERE t.company_id IN (SELECT id FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`})`);
  await run(sql`
    DELETE c FROM chatbase.contacts c
    WHERE c.company_id IN (SELECT id FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`})`);
  await run(sql`
    DELETE m FROM chatbase.company_memberships m
    WHERE m.company_id IN (SELECT id FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`})
       OR m.user_id IN (SELECT id FROM chatbase.profiles WHERE email LIKE ${`${PREFIX}%`})`);
  await run(sql`
    DELETE r FROM chatbase.roles r
    WHERE r.company_id IN (SELECT id FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`})`);
  await run(sql`DELETE FROM chatbase.inboxes WHERE name LIKE ${`${PREFIX}%`}`);
  await run(sql`DELETE FROM chatbase.error_logs WHERE source LIKE ${`${PREFIX}%`}`);
  await run(sql`DELETE FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`}`);
  await run(sql`DELETE FROM chatbase.auth_users WHERE email LIKE ${`${PREFIX}%`}`);
  await run(sql`DELETE FROM chatbase.ycloud_accounts WHERE name LIKE ${`${PREFIX}%`}`);
}

async function leftovers() {
  const [row] = await sys.run(sql`
    SELECT
      (SELECT COUNT(*) FROM chatbase.companies WHERE slug LIKE ${`${PREFIX}%`}) +
      (SELECT COUNT(*) FROM chatbase.inboxes WHERE name LIKE ${`${PREFIX}%`}) +
      (SELECT COUNT(*) FROM chatbase.profiles WHERE email LIKE ${`${PREFIX}%`}) +
      (SELECT COUNT(*) FROM chatbase.error_logs WHERE source LIKE ${`${PREFIX}%`}) +
      (SELECT COUNT(*) FROM chatbase.ycloud_accounts WHERE name LIKE ${`${PREFIX}%`}) AS n`);
  return Number(row.n);
}

const selectOne = async (table: string, id: string) => {
  const [row] = await sys.run(sql`SELECT * FROM ${raw(`chatbase.${table}`)} WHERE id = ${id}`);
  return row;
};
const ageRow = (table: string, id: string) =>
  sys.run(sql`UPDATE ${raw(`chatbase.${table}`)} SET updated_at = ${OLD} WHERE id = ${id}`);
const touched = async (table: string, id: string) =>
  instant((await selectOne(table, id)).updated_at)! > instant(OLD)!;

const isRls = (result: any) => /row-level security/.test(result?.error?.message ?? "");

type World = Awaited<ReturnType<typeof buildWorld>>;

/** Two fake companies, with one user per kind of access. */
async function buildWorld(run: string) {
  const name = (suffix: string) => `${PREFIX}${run}-${suffix}`;
  const newCompany = async (suffix: string) => {
    const r = await R.companies.insertCompany(sys, { name: name(suffix), slug: name(suffix), guid_company: null });
    if (r.error) throw new Error(`insertCompany: ${r.error.code}`);
    return r.data.id as string;
  };
  const companyA = await newCompany("a");
  const companyB = await newCompany("b");

  const allPermissions = await R.roles.listPermissions(sys);
  const codes: string[] = allPermissions.data.map((p: any) => p.code);
  const ids = await R.roles.listPermissionsByCodes(sys, codes);
  const permissionId = new Map<string, string>(ids.data.map((p: any) => [p.code, p.id]));

  const newRole = async (company: string, suffix: string, grant: string[]) => {
    const r = await R.roles.insertRole(sys, { company_id: company, name: name(suffix), description: null, is_system: false });
    if (r.error) throw new Error(`insertRole: ${r.error.code}`);
    const links = grant.map((code) => ({ role_id: r.data.id, permission_id: permissionId.get(code)! }));
    if (links.length) {
      const e = await R.roles.insertRolePermissionRows(sys, links);
      if (e.error) throw new Error(`insertRolePermissionRows: ${e.error.code}`);
    }
    return r.data.id as string;
  };

  const newUser = async (suffix: string, isAdmin = false) => {
    const id = randomUUID();
    const email = `${name(suffix)}@example.invalid`;
    await sys.run(sql`
      INSERT INTO chatbase.auth_users (id, email, password_hash) VALUES (${id}, ${email}, ${"!"})`);
    await sys.run(sql`
      INSERT INTO chatbase.profiles (id, email, full_name, is_platform_admin)
      VALUES (${id}, ${email}, ${name(suffix)}, ${isAdmin})`);
    return id;
  };

  const roleFullA = await newRole(companyA, "full-a", codes);
  const roleFullB = await newRole(companyB, "full-b", codes);
  const roleViewA = await newRole(companyA, "view-a", ["conversations.view"]);
  const roleTaggerA = await newRole(companyA, "tagger-a", ["conversations.view", "tags.manage", "conversations.tag"]);

  const member = async (user: string, company: string, role: string) => {
    const r = await R.memberships.insertMembership(sys, { company_id: company, user_id: user, is_active: true });
    if (r.error) throw new Error(`insertMembership: ${r.error.code}`);
    const e = await R.memberships.insertMembershipRole(sys, { membership_id: r.data.id, role_id: role });
    if (e.error) throw new Error(`insertMembershipRole: ${e.error.code}`);
    return r.data.id as string;
  };

  const users = {
    admin: await newUser("admin", true),
    manager: await newUser("manager"),
    agent: await newUser("agent"),
    tagger: await newUser("tagger"),
    outsider: await newUser("outsider"),
    spare: await newUser("spare"),
  };
  const membershipManager = await member(users.manager, companyA, roleFullA);
  const membershipAgent = await member(users.agent, companyA, roleViewA);
  const membershipTagger = await member(users.tagger, companyA, roleTaggerA);
  const membershipOutsider = await member(users.outsider, companyB, roleFullB);

  const newInbox = async (suffix: string, company: string | null) => {
    const phone = `pm-${run}-${suffix}`;
    const r = await R.ycloud.insertSyncedInbox(sys, {
      name: name(suffix), phone_number: phone, company_id: company,
    });
    if (r.error) throw new Error(`insertSyncedInbox: ${r.error.code}`);
    return r.data.id as string;
  };
  const inboxA = await newInbox("ia", companyA);
  const inboxA2 = await newInbox("ia2", companyA);
  const inboxB = await newInbox("ib", companyB);
  const inboxFree = await newInbox("if", null);

  const linkInbox = await R.memberships.insertMembershipInboxes(sys, [
    { membership_id: membershipAgent, inbox_id: inboxA },
    { membership_id: membershipTagger, inbox_id: inboxA },
  ]);
  if (linkInbox.error) throw new Error(`insertMembershipInboxes: ${linkInbox.error.code}`);

  const newContact = async (company: string, suffix: string) => {
    const r = await R.conversations.upsertContactByPhone(sys, {
      companyId: company, phoneNumber: `pm-${run}-${suffix}`, name: name(suffix),
    });
    if (r.error) throw new Error(`upsertContactByPhone: ${r.error.code}`);
    return r.data.id as string;
  };
  const contactA = await newContact(companyA, "ca");
  const contactB = await newContact(companyB, "cb");

  const newConversation = async (company: string, inbox: string, contact: string, assignee: string) => {
    const r = await R.conversations.upsertOpenConversation(sys, {
      companyId: company, inboxId: inbox, contactId: contact, assigneeId: assignee,
    });
    if (r.error) throw new Error(`upsertOpenConversation: ${r.error.code}`);
    return r.data.id as string;
  };
  const conversationA = await newConversation(companyA, inboxA, contactA, users.agent);
  const conversationB = await newConversation(companyB, inboxB, contactB, users.outsider);

  return {
    run, name, companyA, companyB, users, permissionId, codes,
    roleFullA, roleViewA, membershipManager, membershipAgent, membershipTagger, membershipOutsider,
    inboxA, inboxA2, inboxB, inboxFree, contactA, contactB, conversationA, conversationB,
    db: {
      admin: userSqlDb(users.admin),
      manager: userSqlDb(users.manager),
      agent: userSqlDb(users.agent),
      tagger: userSqlDb(users.tagger),
      outsider: userSqlDb(users.outsider),
    },
  };
}

async function writesCompanies(w: World) {
  const fn = "companies.insertCompany";
  const rls = await R.companies.insertCompany(w.db.manager, { name: w.name("x1"), slug: w.name("x1"), guid_company: null });
  check(fn, "non-admin gets the RLS error", isRls(rls));
  const byAdmin = await R.companies.insertCompany(w.db.admin, { name: w.name("x2"), slug: w.name("x2"), guid_company: "pm-guid" });
  check(fn, "admin inserts and gets the id", !byAdmin.error && byAdmin.data?.id);
  const duplicate = await R.companies.insertCompany(sys, { name: w.name("x2"), slug: w.name("x2"), guid_company: null });
  check(fn, "duplicate slug comes back as error", duplicate.error);

  const up = "companies.updateCompanyById";
  await ageRow("companies", byAdmin.data.id);
  const denied = await R.companies.updateCompanyById(w.db.manager, byAdmin.data.id, { name: "no", slug: w.name("no"), is_active: false, guid_company: null });
  check(up, "non-admin: no error, no change", !denied.error && (await selectOne("companies", byAdmin.data.id)).name === w.name("x2"));
  const updated = await R.companies.updateCompanyById(w.db.admin, byAdmin.data.id, { name: w.name("x3"), slug: w.name("x3"), is_active: false, guid_company: null });
  const row = await selectOne("companies", byAdmin.data.id);
  check(up, "admin updates", !updated.error && row.name === w.name("x3") && row.is_active === false && row.guid_company === null);
  check(up, "updated_at moves", await touched("companies", byAdmin.data.id));
  const bySystem = await R.companies.updateCompanyById(sys, byAdmin.data.id, { name: w.name("x4"), slug: w.name("x4"), is_active: true, guid_company: null });
  check(up, "system updates", !bySystem.error && (await selectOne("companies", byAdmin.data.id)).name === w.name("x4"));
}

async function writesProfiles(w: World) {
  const fn = "profiles.updateProfileFullName";
  await ageRow("profiles", w.users.agent);
  const self = await R.profiles.updateProfileFullName(w.db.agent, w.users.agent, w.name("renamed"));
  const row = await selectOne("profiles", w.users.agent);
  check(fn, "self", !self.error && row.full_name === w.name("renamed") && row.is_platform_admin === false);
  check(fn, "updated_at moves", await touched("profiles", w.users.agent));
  const other = await R.profiles.updateProfileFullName(w.db.agent, w.users.manager, "no");
  check(fn, "another user: no error, no change", !other.error && (await selectOne("profiles", w.users.manager)).full_name === w.name("manager"));
  const byAdmin = await R.profiles.updateProfileFullName(w.db.admin, w.users.manager, w.name("manager2"));
  check(fn, "admin updates anyone", !byAdmin.error && (await selectOne("profiles", w.users.manager)).full_name === w.name("manager2"));
  const bySystem = await R.profiles.updateProfileFullName(sys, w.users.manager, w.name("manager"));
  check(fn, "system updates", !bySystem.error);
  const seen = await R.profiles.getSessionProfile(w.db.manager, w.users.agent);
  check("profiles.getSessionProfile", "colleague visible", !seen.error && seen.data?.id === w.users.agent);
  const notSeen = await R.profiles.getSessionProfile(w.db.outsider, w.users.agent);
  check("profiles.getSessionProfile", "stranger hidden as no_rows", notSeen.error?.code === "PGRST116");
}

async function writesMemberships(w: World) {
  const ins = "memberships.insertMembership";
  const denied = await R.memberships.insertMembership(w.db.outsider, { company_id: w.companyA, user_id: w.users.spare, is_active: true });
  check(ins, "outsider gets the RLS error", isRls(denied));
  const noPermission = await R.memberships.insertMembership(w.db.agent, { company_id: w.companyA, user_id: w.users.spare, is_active: true });
  check(ins, "agent gets the RLS error", isRls(noPermission));
  const created = await R.memberships.insertMembership(w.db.manager, { company_id: w.companyA, user_id: w.users.spare, is_active: true });
  check(ins, "manager inserts", !created.error && created.data?.id);
  const duplicate = await R.memberships.insertMembership(sys, { company_id: w.companyA, user_id: w.users.spare, is_active: true });
  check(ins, "duplicate comes back as error", duplicate.error);
  const id = created.data.id as string;

  const act = "memberships.updateMembershipActive";
  const noChange = await R.memberships.updateMembershipActive(w.db.agent, id, false);
  check(act, "agent: no error, no change", !noChange.error && (await selectOne("company_memberships", id)).is_active === true);
  const off = await R.memberships.updateMembershipActive(w.db.manager, id, false);
  check(act, "manager deactivates", !off.error && (await selectOne("company_memberships", id)).is_active === false);
  await R.memberships.updateMembershipActive(sys, id, true);
  check(act, "system activates", (await selectOne("company_memberships", id)).is_active === true);

  const role = "memberships.insertMembershipRole";
  check(role, "agent gets the RLS error", isRls(await R.memberships.insertMembershipRole(w.db.agent, { membership_id: id, role_id: w.roleViewA })));
  check(role, "outsider gets the RLS error", isRls(await R.memberships.insertMembershipRole(w.db.outsider, { membership_id: id, role_id: w.roleViewA })));
  check(role, "manager inserts", !(await R.memberships.insertMembershipRole(w.db.manager, { membership_id: id, role_id: w.roleViewA })).error);
  check(role, "duplicate comes back as error", (await R.memberships.insertMembershipRole(w.db.manager, { membership_id: id, role_id: w.roleViewA })).error);
  const listed = await R.memberships.listMembershipIdsByRole(w.db.manager, w.roleViewA);
  check("memberships.listMembershipIdsByRole", "sees the link", listed.data?.some((row: any) => row.membership_id === id));

  const delRole = "memberships.deleteMembershipRoles";
  const notByAgent = await R.memberships.deleteMembershipRoles(w.db.agent, id);
  const rolesLeft = await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.membership_roles WHERE membership_id = ${id}`);
  check(delRole, "agent: no error, no change", !notByAgent.error && rolesLeft[0].n === 1);
  const byManager = await R.memberships.deleteMembershipRoles(w.db.manager, id);
  const rolesGone = await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.membership_roles WHERE membership_id = ${id}`);
  check(delRole, "manager deletes", !byManager.error && rolesGone[0].n === 0);

  const inb = "memberships.insertMembershipInboxes";
  check(inb, "agent gets the RLS error", isRls(await R.memberships.insertMembershipInboxes(w.db.agent, [{ membership_id: id, inbox_id: w.inboxA }])));
  check(inb, "manager inserts", !(await R.memberships.insertMembershipInboxes(w.db.manager, [{ membership_id: id, inbox_id: w.inboxA }, { membership_id: id, inbox_id: w.inboxA2 }])).error);

  const links = "memberships.deleteMembershipInboxLinks";
  const notAgent = await R.memberships.deleteMembershipInboxLinks(w.db.agent, [id], [w.inboxA]);
  const count = async () => (await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.membership_inboxes WHERE membership_id = ${id}`))[0].n;
  check(links, "agent: no error, no change", !notAgent.error && (await count()) === 2);
  check(links, "manager removes one", !(await R.memberships.deleteMembershipInboxLinks(w.db.manager, [id], [w.inboxA])).error && (await count()) === 1);

  const del = "memberships.deleteMembershipInboxes";
  const notOutsider = await R.memberships.deleteMembershipInboxes(w.db.outsider, id);
  check(del, "outsider: no error, no change", !notOutsider.error && (await count()) === 1);
  check(del, "manager removes the rest", !(await R.memberships.deleteMembershipInboxes(w.db.manager, id)).error && (await count()) === 0);
  check(del, "system runs", !(await R.memberships.deleteMembershipInboxes(sys, id)).error);

  const session = await R.memberships.listActiveMembershipsForSession(w.db.manager, w.users.manager);
  const codes = session.data?.[0]?.membership_roles?.[0]?.roles?.role_permissions?.length;
  check("memberships.listActiveMembershipsForSession", "permission codes reach the session", codes === w.codes.length);
  const members = await R.memberships.listActiveMembersByRoleName(w.db.manager, w.name("view-a"), w.companyA);
  check("memberships.listActiveMembersByRoleName", "finds the agent with the membership_roles embed", members.data?.length === 1 && members.data[0].membership_roles?.[0]?.roles?.name === w.name("view-a"));
  await sys.run(sql`DELETE FROM chatbase.company_memberships WHERE id = ${id}`);
}

async function writesRoles(w: World) {
  const ins = "roles.insertRole";
  check(ins, "agent gets the RLS error", isRls(await R.roles.insertRole(w.db.agent, { company_id: w.companyA, name: w.name("r1"), description: null, is_system: false })));
  check(ins, "outsider gets the RLS error", isRls(await R.roles.insertRole(w.db.outsider, { company_id: w.companyA, name: w.name("r1"), description: null, is_system: false })));
  check(ins, "a template is refused even to an admin", isRls(await R.roles.insertRole(w.db.admin, { company_id: null, name: w.name("r0"), description: null, is_system: false })));
  const created = await R.roles.insertRole(w.db.manager, { company_id: w.companyA, name: w.name("r1"), description: "d", is_system: false });
  check(ins, "manager inserts", !created.error && created.data?.id);
  const roleId = created.data.id as string;
  check(ins, "duplicate name comes back as error", (await R.roles.insertRole(w.db.manager, { company_id: w.companyA, name: w.name("r1"), description: null, is_system: false })).error);

  const up = "roles.updateCompanyRole";
  await ageRow("roles", roleId);
  const notAgent = await R.roles.updateCompanyRole(w.db.agent, roleId, w.companyA, { name: "no", description: null });
  check(up, "agent: no error, no change", !notAgent.error && (await selectOne("roles", roleId)).name === w.name("r1"));
  const wrongCompany = await R.roles.updateCompanyRole(w.db.admin, roleId, w.companyB, { name: "no", description: null });
  check(up, "wrong company: no change", !wrongCompany.error && (await selectOne("roles", roleId)).name === w.name("r1"));
  const byManager = await R.roles.updateCompanyRole(w.db.manager, roleId, w.companyA, { name: w.name("r2"), description: null });
  const row = await selectOne("roles", roleId);
  check(up, "manager updates", !byManager.error && row.name === w.name("r2") && row.description === null);
  check(up, "updated_at moves", await touched("roles", roleId));

  const found = await R.roles.findCompanyRole(w.db.outsider, roleId, w.companyA);
  check("roles.findCompanyRole", "outsider finds nothing", !found.error && found.data === null);

  const perm = "roles.insertRolePermissionRows";
  const plain = w.permissionId.get("conversations.view")!;
  const platform = w.permissionId.get("companies.manage")!;
  check(perm, "agent gets the RLS error", isRls(await R.roles.insertRolePermissionRows(w.db.agent, [{ role_id: roleId, permission_id: plain }])));
  check(perm, "manager can't grant a platform permission", isRls(await R.roles.insertRolePermissionRows(w.db.manager, [{ role_id: roleId, permission_id: platform }])));
  check(perm, "manager grants a plain permission", !(await R.roles.insertRolePermissionRows(w.db.manager, [{ role_id: roleId, permission_id: plain }])).error);
  check(perm, "admin grants a platform permission", !(await R.roles.insertRolePermissionRows(w.db.admin, [{ role_id: roleId, permission_id: platform }])).error);
  const codes = await R.roles.listRolePermissionCodes(w.db.manager, roleId);
  check("roles.listRolePermissionCodes", "two codes", codes.data?.length === 2 && codes.data.every((row: any) => row.permissions?.code));
  const hidden = await R.roles.listRolePermissionCodes(w.db.outsider, roleId);
  check("roles.listRolePermissionCodes", "outsider sees none", !hidden.error && hidden.data.length === 0);

  const rows = await R.roles.listRolePermissionRows(sys, roleId);
  check("roles.listRolePermissionRows", "fails as PostgREST does: no id column", rows.error);
  const byIds = "roles.deleteRolePermissionsByIds";
  check(byIds, "fails as PostgREST does: no id column", (await R.roles.deleteRolePermissionsByIds(sys, [roleId])).error);
  check(byIds, "for a user too", (await R.roles.deleteRolePermissionsByIds(w.db.manager, [roleId])).error);

  const del = "roles.deleteRolePermissionsByRole";
  const count = async () => (await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.role_permissions WHERE role_id = ${roleId}`))[0].n;
  const notAgent2 = await R.roles.deleteRolePermissionsByRole(w.db.agent, roleId);
  check(del, "agent: no error, no change", !notAgent2.error && (await count()) === 2);
  const byManager2 = await R.roles.deleteRolePermissionsByRole(w.db.manager, roleId);
  check(del, "manager removes plain ones and keeps the platform one", !byManager2.error && (await count()) === 1);
  const byAdmin = await R.roles.deleteRolePermissionsByRole(w.db.admin, roleId);
  check(del, "admin removes the rest", !byAdmin.error && (await count()) === 0);
  check(del, "system runs", !(await R.roles.deleteRolePermissionsByRole(sys, roleId)).error);
  await sys.run(sql`DELETE FROM chatbase.roles WHERE id = ${roleId}`);
}

async function writesTags(w: World) {
  const ins = "tags.insertTag";
  const tag = (suffix: string, kanban: boolean) => ({
    company_id: w.companyA, name: w.name(suffix), color: "#123456", position: 7, is_kanban_column: kanban,
  });
  check(ins, "agent gets the RLS error", isRls(await R.tags.insertTag(w.db.agent, tag("t0", false))));
  check(ins, "tags.manage alone can't make a kanban column", isRls(await R.tags.insertTag(w.db.tagger, tag("k0", true))));
  check(ins, "tags.manage makes a contact tag", !(await R.tags.insertTag(w.db.tagger, tag("t1", false))).error);
  check(ins, "duplicate name comes back as error", (await R.tags.insertTag(w.db.tagger, tag("t1", false))).error);
  const many = await R.tags.insertTags(w.db.manager, [tag("k1", true), tag("k2", true), tag("t2", false), { ...tag("te", false), name: `${w.name("te")}-ñ-😀` }]);
  check("tags.insertTags", "manager inserts several", !many.error);
  check("tags.insertTags", "agent gets the RLS error", isRls(await R.tags.insertTags(w.db.agent, [tag("t9", false)])));
  check("tags.insertTags", "system inserts", !(await R.tags.insertTags(sys, [{ ...tag("t3", false), company_id: w.companyB }])).error);

  const ids = new Map(
    (await sys.run(sql`SELECT id, name, position, is_kanban_column, color FROM chatbase.tags WHERE company_id = ${w.companyA}`)).map((row) => [row.name as string, row]),
  );
  const t1 = ids.get(w.name("t1"))!;
  const t2 = ids.get(w.name("t2"))!;
  const k1 = ids.get(w.name("k1"))!;
  const k2 = ids.get(w.name("k2"))!;
  check("tags.insertTags", "values kept, emoji included", t1.position === 7 && t1.color === "#123456" && t1.is_kanban_column === false && k1.is_kanban_column === true && ids.has(`${w.name("te")}-ñ-😀`));
  check("tags.insertTags", "text over the column's size fails instead of being cut", (await R.tags.insertTags(sys, [{ ...tag("long", false), name: `${w.name("long")}${"x".repeat(250)}` }])).error);

  const up = "tags.updateContactTagById";
  check(up, "kanban column never matches", !(await R.tags.updateContactTagById(sys, k1.id as string, { name: "no", color: "#000000" })).error && (await selectOne("tags", k1.id as string)).name === k1.name);
  const notAgent = await R.tags.updateContactTagById(w.db.agent, t1.id as string, { name: "no", color: "#000000" });
  check(up, "agent: no error, no change", !notAgent.error && (await selectOne("tags", t1.id as string)).name === t1.name);
  const notOutsider = await R.tags.updateContactTagById(w.db.outsider, t1.id as string, { name: "no", color: "#000000" });
  check(up, "outsider: no error, no change", !notOutsider.error && (await selectOne("tags", t1.id as string)).name === t1.name);
  check(up, "tagger updates", !(await R.tags.updateContactTagById(w.db.tagger, t1.id as string, { name: w.name("t1b"), color: "#654321" })).error && (await selectOne("tags", t1.id as string)).color === "#654321");

  const listIds = await R.tags.listCompanyContactTagIds(w.db.manager, w.companyA, [t1.id, k1.id, t2.id]);
  check("tags.listCompanyContactTagIds", "only contact tags", listIds.data?.length === 2);

  const links = "tags.insertContactTagLinks";
  const kanbanLink = await R.tags.insertContactTagLinks(w.db.manager, [{ contact_id: w.contactA, tag_id: k1.id }]);
  check(links, "kanban tag refused with the trigger's message", /Kanban tags cannot be assigned/.test(kanbanLink.error?.message ?? ""));
  check(links, "system too", /Kanban tags cannot be assigned/.test((await R.tags.insertContactTagLinks(sys, [{ contact_id: w.contactA, tag_id: k1.id }])).error?.message ?? ""));
  check(links, "agent gets the RLS error", isRls(await R.tags.insertContactTagLinks(w.db.agent, [{ contact_id: w.contactA, tag_id: t1.id }])));
  check(links, "outsider gets the RLS error", isRls(await R.tags.insertContactTagLinks(w.db.outsider, [{ contact_id: w.contactA, tag_id: t1.id }])));
  check(links, "tagger links", !(await R.tags.insertContactTagLinks(w.db.tagger, [{ contact_id: w.contactA, tag_id: t1.id }, { contact_id: w.contactA, tag_id: t2.id }])).error);
  check(links, "duplicate link comes back as error", (await R.tags.insertContactTagLinks(w.db.tagger, [{ contact_id: w.contactA, tag_id: t1.id }])).error);
  const byContact = await R.contacts.listContactsByIds(w.db.agent, [w.contactA]);
  check("contacts.listContactsByIds", "embed of two tags", byContact.data?.[0]?.contact_tags?.length === 2 && byContact.data[0].companies?.name === w.name("a"));
  const byTag = await R.contacts.listContactIdsByTag(w.db.agent, t1.id as string);
  check("contacts.listContactIdsByTag", "finds the contact", byTag.data?.length === 1);
  check("contacts.listContactIdsByTag", "outsider finds nothing", (await R.contacts.listContactIdsByTag(w.db.outsider, t1.id as string)).data?.length === 0);

  const delLinks = "tags.deleteContactTagLinks";
  const count = async () => (await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.contact_tags WHERE contact_id = ${w.contactA}`))[0].n;
  check(delLinks, "agent: no error, no change", !(await R.tags.deleteContactTagLinks(w.db.agent, w.contactA)).error && (await count()) === 2);
  check(delLinks, "tagger removes", !(await R.tags.deleteContactTagLinks(w.db.tagger, w.contactA)).error && (await count()) === 0);
  check(delLinks, "system runs", !(await R.tags.deleteContactTagLinks(sys, w.contactA)).error);

  const del = "tags.deleteContactTagById";
  check(del, "kanban column never matches", !(await R.tags.deleteContactTagById(w.db.manager, k1.id as string)).error && Boolean(await selectOne("tags", k1.id as string)));
  check(del, "agent: no error, no change", !(await R.tags.deleteContactTagById(w.db.agent, t2.id as string)).error && Boolean(await selectOne("tags", t2.id as string)));
  check(del, "tagger deletes", !(await R.tags.deleteContactTagById(w.db.tagger, t2.id as string)).error && !(await selectOne("tags", t2.id as string)));

  const details = "tags.updateContactDetails";
  await ageRow("contacts", w.contactA);
  const notOutsider2 = await R.tags.updateContactDetails(w.db.outsider, w.contactA, { name: "no", phone_number: "no" });
  check(details, "outsider: no error, no change", !notOutsider2.error && (await selectOne("contacts", w.contactA)).name === w.name("ca"));
  const byAgent = await R.tags.updateContactDetails(w.db.agent, w.contactA, { name: w.name("ca2"), phone_number: `pm-${w.run}-ca` });
  check(details, "agent of the company updates", !byAgent.error && (await selectOne("contacts", w.contactA)).name === w.name("ca2"));
  check(details, "updated_at moves", await touched("contacts", w.contactA));
  check(details, "system updates", !(await R.tags.updateContactDetails(sys, w.contactA, { name: w.name("ca"), phone_number: `pm-${w.run}-ca` })).error);
  const company = await R.tags.getContactCompanyId(w.db.outsider, w.contactA);
  check("tags.getContactCompanyId", "outsider: no_rows", company.error?.code === "PGRST116");

  // Kanban rule: one column per conversation, and contact tags left alone.
  const add = "conversations.addConversationTag";
  const tagged = async () =>
    new Set((await sys.run(sql`SELECT tag_id FROM chatbase.conversation_tags WHERE conversation_id = ${w.conversationA}`)).map((row) => row.tag_id as string));
  check(add, "agent without conversations.tag gets the RLS error", isRls(await R.conversations.addConversationTag(w.db.agent, w.conversationA, k1.id as string)));
  check(add, "outsider gets the RLS error", isRls(await R.conversations.addConversationTag(w.db.outsider, w.conversationA, k1.id as string)));
  check(add, "tagger adds a column", !(await R.conversations.addConversationTag(w.db.tagger, w.conversationA, k1.id as string)).error);
  check(add, "contact tag joins", !(await R.conversations.addConversationTag(w.db.tagger, w.conversationA, t1.id as string)).error);
  check(add, "second column replaces the first", !(await R.conversations.addConversationTag(w.db.tagger, w.conversationA, k2.id as string)).error);
  let current = await tagged();
  check(add, "one column and the contact tag remain", current.size === 2 && current.has(k2.id as string) && current.has(t1.id as string) && !current.has(k1.id as string));
  const dup = await R.conversations.addConversationTag(w.db.tagger, w.conversationA, t1.id as string);
  check(add, "duplicate comes back as error", dup.error);
  current = await tagged();
  check(add, "failed duplicate rolled back", current.size === 2);
  const flags = await R.conversations.listConversationTagsWithKanbanFlag(w.db.tagger, w.conversationA);
  check("conversations.listConversationTagsWithKanbanFlag", "flags", flags.data?.length === 2 && flags.data.some((row: any) => row.tags?.is_kanban_column === true) && flags.data.some((row: any) => row.tags?.is_kanban_column === false));
  const concurrent = await Promise.all([k1, k2, k1, k2, k1, k2].map((t) => R.conversations.addConversationTag(sys, w.conversationA, t.id as string)));
  current = await tagged();
  const columns = [...current].filter((id) => id === k1.id || id === k2.id);
  check(add, `concurrent columns leave exactly one (${concurrent.filter((r) => !r.error).length} ok)`, columns.length === 1);

  const rem = "conversations.removeConversationTags";
  check(rem, "agent: no error, no change", !(await R.conversations.removeConversationTags(w.db.agent, w.conversationA, [t1.id as string])).error && (await tagged()).has(t1.id as string));
  check(rem, "tagger removes", !(await R.conversations.removeConversationTags(w.db.tagger, w.conversationA, [t1.id as string])).error && !(await tagged()).has(t1.id as string));
  check(rem, "system removes", !(await R.conversations.removeConversationTags(sys, w.conversationA, [...(await tagged())])).error && (await tagged()).size === 0);

  const sameCompany = await R.kanban.listKanbanColumnIds(w.db.agent, w.companyA);
  check("kanban.listKanbanColumnIds", "agent sees the columns", sameCompany.data?.length === 2);
  check("kanban.listKanbanColumnIds", "outsider sees none", (await R.kanban.listKanbanColumnIds(w.db.outsider, w.companyA)).data?.length === 0);
}

async function writesInboxes(w: World) {
  const asg = "inboxes.assignInboxesToCompany";
  const company = async (id: string) => (await selectOne("inboxes", id)).company_id;
  check(asg, "agent: no match, silent", !(await R.inboxes.assignInboxesToCompany(w.db.agent, [w.inboxFree], w.companyA)).error && (await company(w.inboxFree)) === null);
  const across = await R.inboxes.assignInboxesToCompany(w.db.manager, [w.inboxA2], w.companyB);
  check(asg, "manager can't move an inbox to another company", isRls(across) && (await company(w.inboxA2)) === w.companyA);
  check(asg, "admin assigns", !(await R.inboxes.assignInboxesToCompany(w.db.admin, [w.inboxFree], w.companyA)).error && (await company(w.inboxFree)) === w.companyA);
  check(asg, "system assigns", !(await R.inboxes.assignInboxesToCompany(sys, [w.inboxFree], w.companyB)).error && (await company(w.inboxFree)) === w.companyB);

  const un = "inboxes.unassignCompanyInboxes";
  check(un, "wrong company: no change", !(await R.inboxes.unassignCompanyInboxes(sys, [w.inboxFree], w.companyA)).error && (await company(w.inboxFree)) === w.companyB);
  check(un, "manager of another company: silent", !(await R.inboxes.unassignCompanyInboxes(w.db.manager, [w.inboxFree], w.companyB)).error && (await company(w.inboxFree)) === w.companyB);
  check(un, "manager of the company: RLS error, needs a company", isRls(await R.inboxes.unassignCompanyInboxes(w.db.outsider, [w.inboxFree], w.companyB)));
  check(un, "admin releases", !(await R.inboxes.unassignCompanyInboxes(w.db.admin, [w.inboxFree], w.companyB)).error && (await company(w.inboxFree)) === null);

  const up = "inboxes.updateInboxById";
  await ageRow("inboxes", w.inboxA2);
  check(up, "agent: no error, no change", !(await R.inboxes.updateInboxById(w.db.agent, w.inboxA2, { name: "no", is_active: false })).error && (await selectOne("inboxes", w.inboxA2)).name === w.name("ia2"));
  check(up, "manager updates", !(await R.inboxes.updateInboxById(w.db.manager, w.inboxA2, { name: w.name("ia2b"), is_active: false })).error);
  const row = await selectOne("inboxes", w.inboxA2);
  check(up, "values", row.name === w.name("ia2b") && row.is_active === false);
  check(up, "updated_at moves", await touched("inboxes", w.inboxA2));
  check(up, "outsider: no change", !(await R.inboxes.updateInboxById(w.db.outsider, w.inboxA2, { name: "no", is_active: true })).error && (await selectOne("inboxes", w.inboxA2)).is_active === false);
  check(up, "system updates", !(await R.inboxes.updateInboxById(sys, w.inboxA2, { name: w.name("ia2"), is_active: true })).error);

  const active = await R.inboxes.listActiveCompanyInboxIds(w.db.agent, w.companyA, [w.inboxA, w.inboxA2]);
  check("inboxes.listActiveCompanyInboxIds", "agent sees only its assigned inbox", active.data?.length === 1 && active.data[0].id === w.inboxA);
  const paged = await R.inboxes.listInboxesPage(w.db.agent, { status: "all", from: 0, to: 9 });
  check("inboxes.listInboxesPage", "agent sees only its inbox", paged.count === 1 && paged.data[0].companies?.name === w.name("a"));

  const ins = "ycloud.insertSyncedInbox";
  check(ins, "agent gets the RLS error", isRls(await R.ycloud.insertSyncedInbox(w.db.agent, { name: w.name("i9"), phone_number: `pm-${w.run}-i9`, company_id: w.companyA })));
  check(ins, "manager can't insert without a company", isRls(await R.ycloud.insertSyncedInbox(w.db.manager, { name: w.name("i9"), phone_number: `pm-${w.run}-i9`, company_id: null })));
  const byManager = await R.ycloud.insertSyncedInbox(w.db.manager, { name: w.name("i8"), phone_number: `pm-${w.run}-i8`, company_id: w.companyA });
  check(ins, "manager inserts and gets the synced columns", !byManager.error && Object.keys(byManager.data ?? {}).sort().join() === "id,name,phone_number,waba_id,ycloud_account_id,ycloud_phone_number_id");
  check(ins, "unknown column fails", (await R.ycloud.insertSyncedInbox(sys, { name: w.name("i7"), phone_number: `pm-${w.run}-i7`, nope: 1 })).error);
  check(ins, "duplicate phone comes back as error", (await R.ycloud.insertSyncedInbox(sys, { name: w.name("i6"), phone_number: `pm-${w.run}-i8` })).error);

  const upd = "ycloud.updateSyncedInbox";
  const id = byManager.data.id as string;
  await ageRow("inboxes", id);
  check(upd, "agent: no error, no change", !(await R.ycloud.updateSyncedInbox(w.db.agent, id, { waba_id: "no" })).error && (await selectOne("inboxes", id)).waba_id === null);
  check(upd, "manager updates", !(await R.ycloud.updateSyncedInbox(w.db.manager, id, { waba_id: "pm-waba" })).error && (await selectOne("inboxes", id)).waba_id === "pm-waba");
  check(upd, "updated_at moves", await touched("inboxes", id));
  check(upd, "manager can't move it away", isRls(await R.ycloud.updateSyncedInbox(w.db.manager, id, { company_id: w.companyB })));
  check(upd, "uppercase company id is the same company", !(await R.ycloud.updateSyncedInbox(w.db.manager, id, { company_id: w.companyA.toUpperCase() })).error && (await selectOne("inboxes", id)).company_id === w.companyA);
  const upperInbox = await R.ycloud.insertSyncedInbox(w.db.manager, { name: w.name("i5"), phone_number: `pm-${w.run}-i5`, company_id: w.companyA.toUpperCase() });
  check(ins, "uppercase company id is the same company", !upperInbox.error);
  check(upd, "system updates", !(await R.ycloud.updateSyncedInbox(sys, id, { waba_id: null })).error);

  const accounts = "ycloud.insertYCloudAccount";
  check(accounts, "user gets the RLS error", isRls(await R.ycloud.insertYCloudAccount(w.db.admin, { name: w.name("y0"), api_key_encrypted: "x" })));
  const account = await R.ycloud.insertYCloudAccount(sys, { name: w.name("y1"), api_key_encrypted: "fake", api_key_last4: "fake" });
  check(accounts, "system inserts and gets the columns", !account.error && Object.keys(account.data ?? {}).sort().join() === "api_key_encrypted,api_key_last4,id,is_active,name,webhook_secret_encrypted,ycloud_webhook_endpoint_id");
  const accountId = account.data.id as string;
  check("ycloud.findYCloudAccount", "system finds", (await R.ycloud.findYCloudAccount(sys, accountId)).data?.id === accountId);
  check("ycloud.findYCloudAccount", "user finds nothing", (await R.ycloud.findYCloudAccount(w.db.admin, accountId)).data === null);
  check("ycloud.findYCloudAccountName", "user finds nothing", (await R.ycloud.findYCloudAccountName(w.db.admin, accountId)).data === null);
  check("ycloud.listYCloudAccounts", "user lists nothing", (await R.ycloud.listYCloudAccounts(w.db.admin)).data?.length === 0);

  const updA = "ycloud.updateYCloudAccount";
  await ageRow("ycloud_accounts", accountId);
  const updated = await R.ycloud.updateYCloudAccount(sys, accountId, { ycloud_webhook_endpoint_id: "pm-ep" });
  check(updA, "returns the row", !updated.error && updated.data?.ycloud_webhook_endpoint_id === "pm-ep");
  check(updA, "updated_at moves", await touched("ycloud_accounts", accountId));
  check(updA, "user: no_rows, as a returning update with no policy", (await R.ycloud.updateYCloudAccount(w.db.admin, accountId, { name: "no" })).error?.code === "PGRST116");
  check(updA, "missing row: no_rows", (await R.ycloud.updateYCloudAccount(sys, NIL, { name: "no" })).error?.code === "PGRST116");
  const save = "ycloud.saveYCloudAccountWebhook";
  check(save, "system saves", !(await R.ycloud.saveYCloudAccountWebhook(sys, accountId, { webhook_secret_encrypted: "fake" })).error && (await selectOne("ycloud_accounts", accountId)).webhook_secret_encrypted === "fake");
  check(save, "user: no error, no change", !(await R.ycloud.saveYCloudAccountWebhook(w.db.admin, accountId, { webhook_secret_encrypted: "no" })).error && (await selectOne("ycloud_accounts", accountId)).webhook_secret_encrypted === "fake");

  // Touches every real inbox without an account on the system path, so it never commits.
  const link = "ycloud.assignYCloudAccountToUnlinkedInboxes";
  class Rollback extends Error {}
  await inTransaction(sys, async (tx) => {
    const result = await R.ycloud.assignYCloudAccountToUnlinkedInboxes(tx, accountId);
    check(link, "system links", !result.error);
    const [left] = await tx.run(sql`SELECT COUNT(*) AS n FROM chatbase.inboxes WHERE ycloud_account_id IS NULL`);
    check(link, "nothing left unlinked", left.n === 0);
    throw new Rollback();
  }).catch((err) => {
    if (!(err instanceof Rollback)) throw err;
  });
  check(link, "agent changes nothing", !(await R.ycloud.assignYCloudAccountToUnlinkedInboxes(w.db.agent, accountId)).error && (await selectOne("inboxes", w.inboxA)).ycloud_account_id === null);
  const byManagerLink = await R.ycloud.assignYCloudAccountToUnlinkedInboxes(w.db.manager, accountId);
  check(link, "manager links its company's only", !byManagerLink.error && (await selectOne("inboxes", w.inboxA)).ycloud_account_id === accountId && (await selectOne("inboxes", w.inboxB)).ycloud_account_id === null);
  await R.ycloud.updateSyncedInbox(sys, w.inboxA, { ycloud_account_id: null });
  await sys.run(sql`UPDATE chatbase.inboxes SET ycloud_account_id = NULL WHERE ycloud_account_id = ${accountId}`);

  const creds = await R.ycloud.findInboxForCredentials(w.db.outsider, w.inboxA);
  check("ycloud.findInboxForCredentials", "outsider finds nothing", !creds.error && creds.data === null);
  check("ycloud.listInboxesForPhoneSync", "outsider lists only its own", (await R.ycloud.listInboxesForPhoneSync(w.db.outsider)).data?.every((row: any) => row.id !== w.inboxA));
}

async function writesConversations(w: World) {
  const contact = "conversations.upsertContactByPhone";
  const phone = `pm-${w.run}-cc`;
  check(contact, "outsider gets the RLS error", isRls(await R.conversations.upsertContactByPhone(w.db.outsider, { companyId: w.companyA, phoneNumber: phone, name: "x" })));
  const first = await R.conversations.upsertContactByPhone(w.db.agent, { companyId: w.companyA, phoneNumber: phone, name: w.name("n1") });
  check(contact, "agent inserts", !first.error && first.data?.id);
  const id = first.data.id as string;
  await ageRow("contacts", id);
  const second = await R.conversations.upsertContactByPhone(w.db.agent, { companyId: w.companyA, phoneNumber: phone, name: w.name("n2") });
  check(contact, "same id, new name", second.data?.id === id && (await selectOne("contacts", id)).name === w.name("n2"));
  check(contact, "updated_at moves", await touched("contacts", id));
  const concurrentPhone = `pm-${w.run}-cd`;
  const parallel = await Promise.all(
    Array.from({ length: 8 }, (_, i) => R.conversations.upsertContactByPhone(sys, { companyId: w.companyA, phoneNumber: concurrentPhone, name: `${w.name("p")}${i}` })),
  );
  const parallelIds = new Set(parallel.map((r) => r.data?.id));
  check(contact, "concurrent upserts: no errors, one row", parallel.every((r) => !r.error) && parallelIds.size === 1);
  const stored = await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.contacts WHERE company_id = ${w.companyA} AND phone_number = ${concurrentPhone}`);
  check(contact, "one stored row", stored[0].n === 1);

  const conv = "conversations.upsertOpenConversation";
  const args = { companyId: w.companyA, inboxId: w.inboxA, contactId: id, assigneeId: w.users.agent };
  check(conv, "outsider gets the RLS error", isRls(await R.conversations.upsertOpenConversation(w.db.outsider, args)));
  const c1 = await R.conversations.upsertOpenConversation(w.db.agent, args);
  check(conv, "agent inserts", !c1.error && c1.data?.id);
  const convId = c1.data.id as string;
  await sys.run(sql`UPDATE chatbase.conversations SET status = N'closed', assignee_id = NULL, updated_at = ${OLD} WHERE id = ${convId}`);
  const c2 = await R.conversations.upsertOpenConversation(w.db.agent, args);
  const row = await selectOne("conversations", convId);
  check(conv, "reopens the same row", c2.data?.id === convId && row.status === "open" && row.assignee_id === w.users.agent);
  check(conv, "updated_at moves", await touched("conversations", convId));
  const parallelContact = [...parallelIds][0] as string;
  const parallelConv = await Promise.all(
    Array.from({ length: 8 }, () => R.conversations.upsertOpenConversation(sys, { ...args, contactId: parallelContact })),
  );
  check(conv, "concurrent upserts: no errors, one row", parallelConv.every((r) => !r.error) && new Set(parallelConv.map((r) => r.data?.id)).size === 1);

  const asg = "conversations.setConversationAssignee";
  await ageRow("conversations", convId);
  check(asg, "outsider: no error, no change", !(await R.conversations.setConversationAssignee(w.db.outsider, convId, null)).error && (await selectOne("conversations", convId)).assignee_id === w.users.agent);
  check(asg, "agent unassigns", !(await R.conversations.setConversationAssignee(w.db.agent, convId, null)).error && (await selectOne("conversations", convId)).assignee_id === null);
  check(asg, "updated_at moves", await touched("conversations", convId));
  check(asg, "system assigns", !(await R.conversations.setConversationAssignee(sys, convId, w.users.agent)).error && (await selectOne("conversations", convId)).assignee_id === w.users.agent);

  const read = "conversations.markConversationRead";
  await sys.run(sql`UPDATE chatbase.conversations SET unread_count = 3, updated_at = ${OLD} WHERE id = ${convId}`);
  check(read, "outsider: no change", !(await R.conversations.markConversationRead(w.db.outsider, convId)).error && (await selectOne("conversations", convId)).unread_count === 3);
  check(read, "agent reads", !(await R.conversations.markConversationRead(w.db.agent, convId)).error && (await selectOne("conversations", convId)).unread_count === 0);
  check(read, "updated_at moves", await touched("conversations", convId));
  await ageRow("conversations", convId);
  check(read, "already read: no write", !(await R.conversations.markConversationRead(sys, convId)).error && !(await touched("conversations", convId)));

  const last = "messaging.updateConversationLastMessage";
  const now = "2026-02-03T04:05:06.789+02:00";
  check(last, "unknown column fails", (await R.messaging.updateConversationLastMessage(sys, convId, { nope: 1 })).error);
  await ageRow("conversations", convId);
  check(last, "agent updates, zone normalized to UTC, updated_at patch dropped", !(await R.messaging.updateConversationLastMessage(w.db.agent, convId, { last_message_at: now, last_message_preview: "😀 previa", updated_at: OLD })).error);
  const after = await selectOne("conversations", convId);
  check(last, "instant kept", instant(after.last_message_at) === Date.parse(now));
  check(last, "emoji kept", after.last_message_preview === "😀 previa");
  check(last, "updated_at moves", await touched("conversations", convId));
  check(last, "outsider: no change", !(await R.messaging.updateConversationLastMessage(w.db.outsider, convId, { last_message_preview: "no" })).error && (await selectOne("conversations", convId)).last_message_preview === "😀 previa");
  check(last, "can't move to an unreachable inbox", isRls(await R.messaging.updateConversationLastMessage(w.db.agent, convId, { inbox_id: w.inboxB })));
  check(last, "empty patch is a no-op", !(await R.messaging.updateConversationLastMessage(sys, convId, {})).error);

  const prev = "messaging.updateConversationPreviewIfUnchanged";
  const later = "2026-02-03T05:00:00.000Z";
  const earlier = "2026-02-03T01:00:00.000Z";
  const previewOf = async () => (await selectOne("conversations", convId)).last_message_preview;
  check(prev, "other case doesn't match", !(await R.messaging.updateConversationPreviewIfUnchanged(sys, convId, "x", "😀 PREVIA", later)).error && (await previewOf()) === "😀 previa");
  check(prev, "trailing space doesn't match", !(await R.messaging.updateConversationPreviewIfUnchanged(sys, convId, "x", "😀 previa ", later)).error && (await previewOf()) === "😀 previa");
  check(prev, "a later message blocks it", !(await R.messaging.updateConversationPreviewIfUnchanged(sys, convId, "x", "😀 previa", earlier)).error && (await previewOf()) === "😀 previa");
  check(prev, "outsider: no change", !(await R.messaging.updateConversationPreviewIfUnchanged(w.db.outsider, convId, "x", "😀 previa", later)).error && (await previewOf()) === "😀 previa");
  await ageRow("conversations", convId);
  check(prev, "matches and writes", !(await R.messaging.updateConversationPreviewIfUnchanged(w.db.agent, convId, "nueva", "😀 previa", later)).error && (await previewOf()) === "nueva");
  check(prev, "updated_at moves", await touched("conversations", convId));

  const found = await R.conversations.findConversationForList(w.db.agent, convId);
  check("conversations.findConversationForList", "agent gets the embeds", found.data?.contacts?.id === id && found.data?.inboxes?.name === w.name("ia"));
  check("conversations.findConversationForList", "outsider gets null", (await R.conversations.findConversationForList(w.db.outsider, convId)).data === null);
  const assigned = await R.conversations.listConversationsAssignedTo(w.db.agent, w.users.agent);
  check("conversations.listConversationsAssignedTo", "agent's", assigned.data?.some((row: any) => row.id === convId));
  const mine = await R.conversations.listConversationsPage(w.db.agent, { limit: 50, assignee: "mine", currentUserId: w.users.agent });
  check("conversations.listConversationsPage", "mine", mine.data?.some((row: any) => row.id === convId));
  check("dashboard.countOpenConversationsInInbox", "agent counts", ((await R.dashboard.countOpenConversationsInInbox(w.db.agent, w.inboxA)).count ?? 0) >= 2);
  check("dashboard.countOpenConversationsInInbox", "outsider counts none", (await R.dashboard.countOpenConversationsInInbox(w.db.outsider, w.inboxA)).count === 0);
  const assignee = await R.conversations.findConversationAssignee(w.db.outsider, convId);
  check("conversations.findConversationAssignee", "outsider: null", !assignee.error && assignee.data === null);
  const inboxNew = await R.conversations.findInboxForNewConversation(w.db.agent, w.inboxA2);
  check("conversations.findInboxForNewConversation", "unassigned inbox: no_rows", inboxNew.error?.code === "PGRST116");
  const wrongRole = await R.conversations.findActiveMembershipWithRole(w.db.manager, w.users.agent, w.companyA, w.name("view-a").toUpperCase());
  check("conversations.findActiveMembershipWithRole", "role name compared exactly", !wrongRole.error && wrongRole.data === null);
  const rightRole = await R.conversations.findActiveMembershipWithRole(w.db.manager, w.users.agent, w.companyA, w.name("view-a"));
  check("conversations.findActiveMembershipWithRole", "right name, embed", rightRole.data?.membership_roles?.[0]?.roles?.name === w.name("view-a"));
  const latest = await R.conversations.listLatestConversationOfContacts(w.db.agent, w.companyA, [id, parallelContact]);
  check("conversations.listLatestConversationOfContacts", "one row", latest.data?.length === 1);
  const phones = await R.conversations.listContactsByPhoneNumbers(w.db.outsider, w.companyA, [phone]);
  check("conversations.listContactsByPhoneNumbers", "outsider: none", phones.data?.length === 0);
  return { conversation: convId, contact: id };
}

async function writesMessages(w: World, own: { conversation: string; contact: string }) {
  const conv = own.conversation;
  const ins = "messaging.insertMessage";
  const base = { conversation_id: conv, company_id: w.companyA, direction: "outbound", type: "text", body: "hola 😀", status: "sent" };
  check(ins, "agent without conversations.reply gets the RLS error", isRls(await R.messaging.insertMessage(w.db.agent, { ...base })));
  check(ins, "outsider gets the RLS error", isRls(await R.messaging.insertMessage(w.db.outsider, { ...base })));
  check(ins, "bad conversation id gets the RLS error", isRls(await R.messaging.insertMessage(w.db.manager, { ...base, conversation_id: "not-a-uuid" })));
  check(ins, "unknown column fails", (await R.messaging.insertMessage(sys, { ...base, nope: 1 })).error);
  const yid = `pm-${w.run}-y1`;
  const payload = { sendTime: "2026-01-02T03:04:05.000+02:00", nested: { a: 1 }, text: "ñ" };
  const inserted = await R.messaging.insertMessage(w.db.manager, {
    ...base, ycloud_message_id: yid, sent_by: w.users.manager, raw_payload: payload,
    template_components: [{ a: 1 }], wamid: `pm-${w.run}-w1`, reply_to_wamid: null,
    created_at: "2026-02-03T04:05:06.789Z",
  });
  check(ins, "manager inserts", !inserted.error);
  const m = inserted.data;
  const { data: sampleMessage } = await sb.from("messages").select("*").limit(1).eq("id", NIL);
  void sampleMessage;
  check(ins, "row looks right", m?.body === "hola 😀" && m?.direction === "outbound" && m?.status === "sent" && m?.sent_by === w.users.manager);
  check(ins, "json comes back parsed", m?.raw_payload?.nested?.a === 1 && m?.raw_payload?.text === "ñ" && Array.isArray(m?.template_components) && Array.isArray(m?.reactions) && m?.reactions.length === 0);
  check(ins, "an app send keeps its own created_at", instant(m?.created_at) === Date.parse("2026-02-03T04:05:06.789Z"));
  const dup = await R.messaging.insertMessage(sys, { ...base, ycloud_message_id: yid });
  check(ins, "duplicate ycloud id comes back as error", dup.error);
  const echo = await R.messaging.insertMessage(sys, { ...base, ycloud_message_id: `${yid}e`, raw_payload: payload });
  check(ins, "an echo takes its send time, zone respected", instant(echo.data?.created_at) === Date.parse(payload.sendTime));
  const echo2 = await R.messaging.insertMessage(sys, { ...base, ycloud_message_id: `${yid}f`, raw_payload: { sendTime: "not a time", createTime: "2026-01-03T00:00:00Z" } });
  check(ins, "bad sendTime falls back to createTime", instant(echo2.data?.created_at) === Date.parse("2026-01-03T00:00:00Z"));
  const echo3 = await R.messaging.insertMessage(sys, { ...base, ycloud_message_id: `${yid}g`, raw_payload: { sendTime: "nope" } });
  check(ins, "no valid time keeps the default", !echo3.error && instant(echo3.data?.created_at)! > Date.parse("2026-11-01T00:00:00Z"));
  const inbound = await R.messaging.insertMessage(sys, { ...base, direction: "inbound", ycloud_message_id: `${yid}h`, raw_payload: payload });
  check(ins, "inbound ignores send time", instant(inbound.data?.created_at)! > Date.parse("2026-11-01T00:00:00Z"));
  const long = "x😀".repeat(3000);
  const longOne = await R.messaging.insertMessage(sys, { ...base, ycloud_message_id: `${yid}l`, body: long });
  check(ins, "long body kept whole", longOne.data?.body === long);

  // Same columns as a real message on Supabase.
  const { data: realMessage } = await sb.from("messages").select("*").eq("direction", "outbound").eq("conversation_id", (await seedConversationForShape())).limit(1).maybeSingle();
  if (realMessage) {
    check(ins, "same columns as a Supabase message", Object.keys(realMessage).sort().join() === Object.keys(m ?? {}).sort().join());
  }

  const reaction = "messaging.getMessageForReaction";
  const got = await R.messaging.getMessageForReaction(w.db.agent, m.id, conv);
  check(reaction, "agent reads", !got.error && got.data?.wamid === `pm-${w.run}-w1` && Array.isArray(got.data?.reactions));
  check(reaction, "outsider: no_rows", (await R.messaging.getMessageForReaction(w.db.outsider, m.id, conv)).error?.code === "PGRST116");
  check(reaction, "wrong conversation: no_rows", (await R.messaging.getMessageForReaction(sys, m.id, w.conversationA)).error?.code === "PGRST116");

  const react = "messaging.updateMessageReactions";
  const list = [{ emoji: "😀", from: "pm" }];
  const reacted = await R.messaging.updateMessageReactions(w.db.agent, m.id, list);
  check(react, "agent reacts and gets the row", !reacted.error && reacted.data?.reactions?.[0]?.emoji === "😀" && reacted.data?.id === m.id);
  check(react, "outsider: no_rows, unchanged", (await R.messaging.updateMessageReactions(w.db.outsider, m.id, [])).error?.code === "PGRST116");
  check(react, "missing message: no_rows", (await R.messaging.updateMessageReactions(sys, NIL, [])).error?.code === "PGRST116");
  check(react, "system reacts", !(await R.messaging.updateMessageReactions(sys, m.id, list)).error);

  const med = "messaging.updateMessagesMediaByYCloudIds";
  check(med, "outsider: no change", !(await R.messaging.updateMessagesMediaByYCloudIds(w.db.outsider, [yid], { media_url: "no" })).error && (await selectOne("messages", m.id)).media_url === null);
  check(med, "other case doesn't match", !(await R.messaging.updateMessagesMediaByYCloudIds(sys, [yid.toUpperCase()], { media_url: "no" })).error && (await selectOne("messages", m.id)).media_url === null);
  check(med, "agent updates", !(await R.messaging.updateMessagesMediaByYCloudIds(w.db.agent, [yid, "pm-none"], { media_url: "pm-url", media_mime: "image/png", media_filename: "ñ.png" })).error);
  const withMedia = await R.media.findMessageMedia(w.db.agent, m.id);
  check("media.findMessageMedia", "reads the media columns", withMedia.data?.media_url === "pm-url" && withMedia.data?.media_mime === "image/png" && withMedia.data?.media_filename === "ñ.png");
  check("media.findMessageMedia", "outsider: null", (await R.media.findMessageMedia(w.db.outsider, m.id)).data === null);
  check(med, "unknown column fails", (await R.messaging.updateMessagesMediaByYCloudIds(sys, [yid], { nope: 1 })).error);
  check(med, "empty list is a no-op", !(await R.messaging.updateMessagesMediaByYCloudIds(sys, [], { media_url: "no" })).error);

  const enrich = "messaging.listEnrichableMessagesByYCloudIds";
  const found = await R.messaging.listEnrichableMessagesByYCloudIds(w.db.agent, [yid]);
  check(enrich, "finds", found.data?.length === 1 && found.data[0].id === m.id && Object.keys(found.data[0]).sort().join() === "body,conversation_id,created_at,id,type");
  check(enrich, "outsider: none", (await R.messaging.listEnrichableMessagesByYCloudIds(w.db.outsider, [yid])).data?.length === 0);
  check(enrich, "empty list: none", (await R.messaging.listEnrichableMessagesByYCloudIds(sys, [])).data?.length === 0);

  const cas = "messaging.updateMessageBodyIfUnchanged";
  const bodyOf = async () => (await selectOne("messages", m.id)).body;
  check(cas, "other case doesn't match", !(await R.messaging.updateMessageBodyIfUnchanged(sys, m.id, "HOLA 😀", { body: "no" })).error && (await bodyOf()) === "hola 😀");
  check(cas, "trailing space doesn't match", !(await R.messaging.updateMessageBodyIfUnchanged(sys, m.id, "hola 😀 ", { body: "no" })).error && (await bodyOf()) === "hola 😀");
  check(cas, "outsider: no change", !(await R.messaging.updateMessageBodyIfUnchanged(w.db.outsider, m.id, "hola 😀", { body: "no" })).error && (await bodyOf()) === "hola 😀");
  check(cas, "agent writes on a match", !(await R.messaging.updateMessageBodyIfUnchanged(w.db.agent, m.id, "hola 😀", { body: "nuevo" })).error && (await bodyOf()) === "nuevo");
  check(cas, "long body compared whole", !(await R.messaging.updateMessageBodyIfUnchanged(sys, longOne.data.id, long, { body: "corto" })).error && (await selectOne("messages", longOne.data.id)).body === "corto");
  check(cas, "can't move to another conversation", isRls(await R.messaging.updateMessageBodyIfUnchanged(w.db.agent, m.id, "nuevo", { conversation_id: w.conversationB })));

  const list2 = await R.messages.listConversationMessagesPage(w.db.agent, conv);
  check("messages.listConversationMessagesPage", "agent reads the thread, without reactions", !list2.error && list2.data.length >= 5 && list2.data.every((row: any) => row.type !== "reaction"));
  check("messages.listConversationMessagesPage", "outsider: empty", (await R.messages.listConversationMessagesPage(w.db.outsider, conv)).data?.length === 0);
  const reactionRow = await R.messaging.insertMessage(sys, { ...base, type: "reaction", ycloud_message_id: `${yid}r` });
  check(ins, "reaction row inserted", !reactionRow.error);
  const list3 = await R.messages.listConversationMessagesPage(sys, conv);
  check("messages.listConversationMessagesPage", "reactions are filtered out", list3.data?.every((row: any) => row.type !== "reaction"));

  // Cursor over a page break with every timestamp tied: the id alone must keep the walk whole.
  const tied = "2026-03-01T00:00:00.123Z";
  const created = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const r = await R.messaging.insertMessage(sys, { ...base, conversation_id: w.conversationA, sent_by: w.users.manager, ycloud_message_id: `${yid}t${i}`, created_at: tied });
    if (r.error) fail("messages.listConversationMessagesPage", "tie setup failed");
    else created.add(r.data.id);
  }
  const walked: string[] = [];
  let before: { ts: string; id: string } | null = null;
  for (let pageNo = 0; pageNo < 5; pageNo++) {
    const page: any = await R.messages.listConversationMessagesPage(sys, w.conversationA, before);
    if (page.error || !page.data.length) break;
    walked.push(...page.data.map((row: any) => row.id));
    const last = page.data[page.data.length - 1];
    before = { ts: last.created_at, id: last.id };
    if (!encodePageCursor(before.ts, before.id)) break;
  }
  check("messages.listConversationMessagesPage", "tied page walk returns each row once", new Set(walked).size === walked.length && [...created].every((id) => walked.includes(id)));

  const inboundList = await R.messages.listInboundMessagesAfter(w.db.agent, "2020-01-01T00:00:00Z");
  check("messages.listInboundMessagesAfter", "agent sees its company's only", !inboundList.error && inboundList.data.every((row: any) => row.conversation_id === conv || row.conversation_id === w.conversationA));
  check("messages.listInboundMessagesAfter", "a bad timestamp is an error, as in Postgres", (await R.messages.listInboundMessagesAfter(sys, "no")).error);
  const dashboardCount = await R.dashboard.countMessagesSince(w.db.agent, "outbound", "2020-01-01T00:00:00Z", null);
  check("dashboard.countMessagesSince", "user counts what it reaches", !dashboardCount.error && (dashboardCount.count ?? 0) >= 10);
  check("dashboard.countMessagesSince", "outsider counts none of it", (await R.dashboard.countMessagesSince(w.db.outsider, "outbound", "2020-01-01T00:00:00Z", [w.inboxA])).count === 0);
  check("dashboard.countMessagesSince", "with inboxes", ((await R.dashboard.countMessagesSince(w.db.agent, "outbound", "2020-01-01T00:00:00Z", [w.inboxA])).count ?? 0) >= 10);
}

let shapeConversation = NIL;
const seedConversationForShape = async () => shapeConversation;

async function writesNotes(w: World, own: { conversation: string }) {
  const ins = "notes.insertConversationNote";
  const note = { conversationId: own.conversation, companyId: w.companyA, authorId: w.users.manager, body: "nota 😀" };
  check(ins, "agent without notes.manage gets the RLS error", isRls(await R.notes.insertConversationNote(w.db.agent, note)));
  check(ins, "outsider gets the RLS error", isRls(await R.notes.insertConversationNote(w.db.outsider, note)));
  const created = await R.notes.insertConversationNote(w.db.manager, note);
  check(ins, "manager inserts, with the shape", !created.error && Object.keys(created.data ?? {}).sort().join() === "body,created_at,id,profiles" && created.data?.profiles?.full_name === w.name("manager") && created.data?.body === "nota 😀");
  const bySystem = await R.notes.insertConversationNote(sys, note);
  check(ins, "system inserts", !bySystem.error);
  const list = await R.notes.listConversationNotes(w.db.agent, own.conversation);
  check("notes.listConversationNotes", "agent reads with profile embed", list.data?.length === 2 && list.data[0].profiles?.email);
  check("notes.listConversationNotes", "outsider: none", (await R.notes.listConversationNotes(w.db.outsider, own.conversation)).data?.length === 0);

  const rem = "notes.removeConversationNote";
  const count = async () => (await sys.run(sql`SELECT COUNT(*) AS n FROM chatbase.conversation_notes WHERE conversation_id = ${own.conversation}`))[0].n;
  check(rem, "agent: no error, no change", !(await R.notes.removeConversationNote(w.db.agent, created.data.id, own.conversation)).error && (await count()) === 2);
  check(rem, "wrong conversation: no change", !(await R.notes.removeConversationNote(sys, created.data.id, w.conversationA)).error && (await count()) === 2);
  check(rem, "manager removes", !(await R.notes.removeConversationNote(w.db.manager, created.data.id, own.conversation)).error && (await count()) === 1);
  check(rem, "system removes", !(await R.notes.removeConversationNote(sys, bySystem.data.id, own.conversation)).error && (await count()) === 0);
}

async function writesTickets(w: World, own: { conversation: string }) {
  const ins = "tickets.insertTicket";
  const ticket = { companyId: w.companyA, conversationId: own.conversation, title: w.name("ticket"), description: "d", priority: "high", createdBy: w.users.manager };
  check(ins, "agent gets the RLS error", isRls(await R.tickets.insertTicket(w.db.agent, ticket)));
  check(ins, "outsider gets the RLS error", isRls(await R.tickets.insertTicket(w.db.outsider, ticket)));
  check(ins, "bad priority comes back as error", (await R.tickets.insertTicket(sys, { ...ticket, priority: "nope" })).error);
  const created = await R.tickets.insertTicket(w.db.manager, ticket);
  check(ins, "manager inserts, nothing returned", !created.error && created.data === null);
  const [row] = await sys.run(sql`SELECT id, assignee_id, status FROM chatbase.tickets WHERE conversation_id = ${own.conversation}`);
  check(ins, "row looks right", row && row.assignee_id === null && row.status === "open");
  const id = row.id as string;

  const owner = await R.tickets.getTicketOwnership(w.db.manager, id);
  check("tickets.getTicketOwnership", "columns", !owner.error && Object.keys(owner.data).sort().join() === "company_id,conversation_id,created_by,id");
  check("tickets.getTicketOwnership", "agent without tickets.view: no_rows", (await R.tickets.getTicketOwnership(w.db.agent, id)).error?.code === "PGRST116");

  const setters: Array<[string, (db: SqlDb) => Promise<any>, (r: any) => boolean]> = [
    ["tickets.setTicketContent", (db) => R.tickets.setTicketContent(db, id, { title: w.name("t2"), description: "e", priority: "low" }), (r) => r.title === w.name("t2") && r.priority === "low"],
    ["tickets.setTicketStatus", (db) => R.tickets.setTicketStatus(db, id, "in_progress"), (r) => r.status === "in_progress"],
    ["tickets.setTicketAssignee", (db) => R.tickets.setTicketAssignee(db, id, w.users.agent), (r) => r.assignee_id === w.users.agent],
    ["tickets.setTicketSupportResponse", (db) => R.tickets.setTicketSupportResponse(db, id, { body: "resp 😀", respondedAt: "2026-02-03T04:05:06.789+02:00", respondedBy: w.users.manager }), (r) => r.support_response === "resp 😀" && instant(r.support_responded_at) === Date.parse("2026-02-03T04:05:06.789+02:00") && r.support_responded_by === w.users.manager],
  ];
  for (const [fn, call, holds] of setters) {
    await ageRow("tickets", id);
    const before = await selectOne("tickets", id);
    const denied = await call(w.db.agent);
    const still = await selectOne("tickets", id);
    check(fn, "agent: no error, no change", !denied.error && instant(still.updated_at) === instant(before.updated_at));
    const outsider = await call(w.db.outsider);
    check(fn, "outsider: no error, no change", !outsider.error && instant((await selectOne("tickets", id)).updated_at) === instant(before.updated_at));
    const done = await call(w.db.manager);
    check(fn, "manager writes", !done.error && holds(await selectOne("tickets", id)));
    check(fn, "updated_at moves", await touched("tickets", id));
    check(fn, "system writes", !(await call(sys)).error);
  }
  await R.tickets.setTicketSupportResponse(sys, id, { body: "r", respondedAt: "2026-02-03T04:05:06.789", respondedBy: w.users.manager });
  check("tickets.setTicketSupportResponse", "a time with no zone is UTC", instant((await selectOne("tickets", id)).support_responded_at) === Date.parse("2026-02-03T04:05:06.789Z"));
  check("tickets.setTicketAssignee", "unassign", !(await R.tickets.setTicketAssignee(sys, id, null)).error && (await selectOne("tickets", id)).assignee_id === null);
  check("tickets.setTicketStatus", "bad status comes back as error", (await R.tickets.setTicketStatus(sys, id, "nope")).error);

  const page = await R.tickets.listTicketsPage(w.db.manager, { status: "all", priority: "all" }, 0, 9);
  check("tickets.listTicketsPage", "manager sees it with embeds", page.count === 1 && page.data[0].companies?.name === w.name("a") && page.data[0].creator?.full_name === w.name("manager") && page.data[0].conversations?.contacts?.name);
  check("tickets.listTicketsPage", "agent sees none", (await R.tickets.listTicketsPage(w.db.agent, { status: "all", priority: "all" }, 0, 9)).count === 0);
  const search = await R.tickets.listTicketsPage(w.db.manager, { status: "all", priority: "low", search: "PRUEBA-MIGRACION" }, 0, 9);
  check("tickets.listTicketsPage", "search ignores case", search.count === 1);
  check("dashboard.countTicketsByStatus", "manager counts", (await R.dashboard.countTicketsByStatus(w.db.manager, "in_progress")).count === 1);
}

async function writesErrors(w: World) {
  const source = `${PREFIX}${w.run}`;
  const ins = "errors.insertErrorLog";
  const row = { level: "warn", status: "open", source, message: "m ñ", context: { a: { b: 1 } }, company_id: w.companyA, user_id: w.users.manager, http_status: 500 };
  check(ins, "user gets the RLS error", isRls(await R.errors.insertErrorLog(w.db.admin, row)));
  check(ins, "unknown column fails", (await R.errors.insertErrorLog(sys, { ...row, nope: 1 })).error);
  check(ins, "bad level comes back as error", (await R.errors.insertErrorLog(sys, { ...row, level: "nope" })).error);
  const created = await R.errors.insertErrorLog(sys, row);
  check(ins, "system inserts, nothing returned", !created.error && created.data === null);

  const list = "errors.listErrorLogsPage";
  const args = { companyId: w.companyA, status: "all", level: "all", source, q: "", from: 0, to: 9 };
  const page = await R.errors.listErrorLogsPage(sys, args);
  check(list, "system finds it", page.count === 1 && page.data[0].context?.a?.b === 1 && page.data[0].companies?.name === w.name("a") && page.data[0].actor?.full_name === w.name("manager") && page.data[0].resolver === null);
  check(list, "manager with error_logs.view reads", (await R.errors.listErrorLogsPage(w.db.manager, args)).count === 1);
  check(list, "agent reads nothing", (await R.errors.listErrorLogsPage(w.db.agent, args)).count === 0);
  check(list, "the q search matches", (await R.errors.listErrorLogsPage(sys, { ...args, q: "M Ñ" })).count === 1);
  const id = page.data[0].id as string;

  const up = "errors.updateErrorLog";
  await ageRow("error_logs", id);
  check(up, "agent: no error, no change", !(await R.errors.updateErrorLog(w.db.agent, id, { status: "resolved" })).error && (await selectOne("error_logs", id)).status === "open");
  check(up, "manager updates", !(await R.errors.updateErrorLog(w.db.manager, id, { status: "resolved", resolved_at: "2026-02-03T04:05:06+02:00", resolved_by: w.users.manager, resolution_note: "ñ" })).error);
  const after = await selectOne("error_logs", id);
  check(up, "values", after.status === "resolved" && instant(after.resolved_at) === Date.parse("2026-02-03T04:05:06+02:00") && after.resolution_note === "ñ");
  check(up, "updated_at moves", await touched("error_logs", id));
  check(up, "unknown column fails", (await R.errors.updateErrorLog(sys, id, { nope: 1 })).error);
  check(up, "empty patch is a no-op", !(await R.errors.updateErrorLog(sys, id, {})).error);
  check(up, "system updates", !(await R.errors.updateErrorLog(sys, id, { context: { c: 2 } })).error && (await R.errors.listErrorLogsPage(sys, args)).data[0].context?.c === 2);
}

async function schemaDrift() {
  // The generic writers name columns by hand: these must be the real ones on both sides.
  const fn = "schema";
  for (const table of ["conversations", "error_logs", "inboxes", "ycloud_accounts", "messages"]) {
    const { data } = await sb.from(table).select("*").limit(1).eq("id", shapeRow[table] ?? NIL).maybeSingle();
    if (!data) continue;
    const found = await sys.run(sql`
      SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'chatbase' AND TABLE_NAME = ${table}`);
    const onSql = new Set(found.map((row) => row.c as string).filter((c) => c !== "change_version"));
    const onSb = new Set(Object.keys(data));
    const missing = [...onSb].filter((c) => !onSql.has(c));
    const extra = [...onSql].filter((c) => !onSb.has(c));
    check(fn, `${table}: columns only on Supabase [${missing}] only on SQL Server [${extra}]`, !missing.length && !extra.length);
  }
}
const shapeRow: Record<string, string> = {};

async function runWrites(seeds: Seed[]) {
  section = "writes";
  const main = seeds[0];
  shapeConversation = main.conversation;
  shapeRow.conversations = main.conversation;
  shapeRow.messages = main.message;
  shapeRow.inboxes = main.inbox;
  shapeRow.ycloud_accounts = (await accountOf(main)) ?? NIL;
  const [log] = await sys.run(sql`SELECT TOP (1) id FROM chatbase.error_logs`);
  if (log) shapeRow.error_logs = log.id as string;
  await schemaDrift();

  await cleanup();
  const run = randomUUID().slice(0, 8);
  try {
    const world = await buildWorld(run);
    const steps: Array<[string, () => Promise<unknown>]> = [];
    let own: { conversation: string; contact: string } = { conversation: NIL, contact: NIL };
    steps.push(["companies", () => writesCompanies(world)]);
    steps.push(["profiles", () => writesProfiles(world)]);
    steps.push(["memberships", () => writesMemberships(world)]);
    steps.push(["roles", () => writesRoles(world)]);
    steps.push(["tags", () => writesTags(world)]);
    steps.push(["inboxes", () => writesInboxes(world)]);
    steps.push(["conversations", async () => { own = await writesConversations(world); }]);
    steps.push(["messages", () => writesMessages(world, own)]);
    steps.push(["notes", () => writesNotes(world, own)]);
    steps.push(["tickets", () => writesTickets(world, own)]);
    steps.push(["errors", () => writesErrors(world)]);
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        fail(`writes.${label}`, `threw ${(err as Error).message.slice(0, 300)}`);
      }
    }
  } finally {
    await cleanup();
    const left = await leftovers();
    check("cleanup", `no fake rows left (${left})`, left === 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Errors: bad ids, `.single()` and collations.
// ---------------------------------------------------------------------------------------------

async function runErrors(seeds: Seed[]) {
  section = "errors";
  const BAD = "not-a-uuid";
  const s = seeds[0];
  const users = [sys, userSqlDb(s.memberUser), userSqlDb(BAD)];
  const single: Array<[string, (db: any) => Promise<any>]> = [
    ["conversations.getConversationCompany", (db) => R.conversations.getConversationCompany(db, BAD)],
    ["conversations.findInboxForNewConversation", (db) => R.conversations.findInboxForNewConversation(db, BAD)],
    ["messaging.getConversationForSending", (db) => R.messaging.getConversationForSending(db, BAD)],
    ["messaging.getConversationForSofia", (db) => R.messaging.getConversationForSofia(db, BAD)],
    ["messaging.getConversationInbox", (db) => R.messaging.getConversationInbox(db, BAD)],
    ["messaging.getMessageForReaction", (db) => R.messaging.getMessageForReaction(db, BAD, BAD)],
    ["messaging.updateMessageReactions", (db) => R.messaging.updateMessageReactions(db, BAD, [])],
    ["profiles.getSessionProfile", (db) => R.profiles.getSessionProfile(db, BAD)],
    ["tags.getContactCompanyId", (db) => R.tags.getContactCompanyId(db, BAD)],
    ["tickets.getTicketOwnership", (db) => R.tickets.getTicketOwnership(db, BAD)],
    ["ycloud.updateYCloudAccount", (db) => R.ycloud.updateYCloudAccount(db, BAD, { name: "x" })],
  ];
  const maybe: Array<[string, (db: any) => Promise<any>]> = [
    ["conversations.findConversationForList", (db) => R.conversations.findConversationForList(db, BAD)],
    ["conversations.findConversationAssignee", (db) => R.conversations.findConversationAssignee(db, BAD)],
    ["conversations.findActiveMembershipWithRole", (db) => R.conversations.findActiveMembershipWithRole(db, BAD, BAD, "x")],
    ["conversations.findCompanyByGuid", (db) => R.conversations.findCompanyByGuid(db, BAD)],
    ["conversations.findCompanyById", (db) => R.conversations.findCompanyById(db, BAD)],
    ["media.findMessageMedia", (db) => R.media.findMessageMedia(db, BAD)],
    ["memberships.findCompanyMembership", (db) => R.memberships.findCompanyMembership(db, BAD, BAD, BAD)],
    ["messaging.findConversationInbox", (db) => R.messaging.findConversationInbox(db, BAD)],
    ["messaging.findInboxId", (db) => R.messaging.findInboxId(db, BAD)],
    ["messaging.findCompanyGuid", (db) => R.messaging.findCompanyGuid(db, BAD)],
    ["roles.findCompanyRole", (db) => R.roles.findCompanyRole(db, BAD, BAD)],
    ["ycloud.findYCloudAccount", (db) => R.ycloud.findYCloudAccount(db, BAD)],
    ["ycloud.findYCloudAccountName", (db) => R.ycloud.findYCloudAccountName(db, BAD)],
    ["ycloud.findInboxForCredentials", (db) => R.ycloud.findInboxForCredentials(db, BAD)],
  ];
  const lists: Array<[string, (db: any) => Promise<any>]> = [
    ["companies.listCompaniesPage", (db) => R.companies.listCompaniesPage(db, { status: "all", includeIds: [BAD], from: 0, to: 9 })],
    ["companies.listCompaniesPage#exclude", (db) => R.companies.listCompaniesPage(db, { status: "all", excludeIds: [BAD], from: 0, to: 9 })],
    ["contacts.listContactIdsByTag", (db) => R.contacts.listContactIdsByTag(db, BAD)],
    ["contacts.listContactIdsPage", (db) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: [BAD], companyId: "", contactIds: null, q: "", from: 0, to: 9 })],
    ["contacts.listContactIdsPage#company", (db) => R.contacts.listContactIdsPage(db, { scopedCompanyIds: null, companyId: BAD, contactIds: [BAD], q: "", from: 0, to: 9 })],
    ["contacts.listContactsByIds", (db) => R.contacts.listContactsByIds(db, [BAD])],
    ["conversations.listConversationsPage", (db) => R.conversations.listConversationsPage(db, { limit: 5, assigneeId: BAD })],
    ["conversations.listConversationsPage#mine", (db) => R.conversations.listConversationsPage(db, { limit: 5, assignee: "mine", currentUserId: BAD })],
    ["conversations.listConversationsPage#contacts", (db) => R.conversations.listConversationsPage(db, { limit: 5, contactIds: [BAD] })],
    ["conversations.listConversationsPage#company", (db) => R.conversations.listConversationsPage(db, { limit: 5, companyId: BAD })],
    ["conversations.listConversationsPage#before", (db) => R.conversations.listConversationsPage(db, { limit: 5, before: { ts: cutoff, id: BAD } })],
    ["conversations.searchContactIdsByNameOrPhone", (db) => R.conversations.searchContactIdsByNameOrPhone(db, "zzzz", "", BAD)],
    ["conversations.listContactIdsByTag", (db) => R.conversations.listContactIdsByTag(db, BAD)],
    ["conversations.listConversationsAssignedTo", (db) => R.conversations.listConversationsAssignedTo(db, BAD)],
    ["conversations.listConversationTagsWithKanbanFlag", (db) => R.conversations.listConversationTagsWithKanbanFlag(db, BAD)],
    ["conversations.listContactsByPhoneNumbers", (db) => R.conversations.listContactsByPhoneNumbers(db, BAD, ["x"])],
    ["conversations.listLatestConversationOfContacts", (db) => R.conversations.listLatestConversationOfContacts(db, BAD, [BAD])],
    ["dashboard.listDashboardInboxes", (db) => R.dashboard.listDashboardInboxes(db, `id.in.(${BAD})`)],
    ["dashboard.listInboxNamesByIds", (db) => R.dashboard.listInboxNamesByIds(db, [BAD])],
    ["errors.listErrorLogsPage", (db) => R.errors.listErrorLogsPage(db, { companyId: BAD, status: "all", level: "all", source: "all", q: "", from: 0, to: 9 })],
    ["inboxes.listCompanyInboxIds", (db) => R.inboxes.listCompanyInboxIds(db, BAD)],
    ["inboxes.listInboxCompaniesByIds", (db) => R.inboxes.listInboxCompaniesByIds(db, [BAD])],
    ["inboxes.listActiveCompanyInboxIds", (db) => R.inboxes.listActiveCompanyInboxIds(db, BAD, [BAD])],
    ["inboxes.listInboxNamesByIds", (db) => R.inboxes.listInboxNamesByIds(db, [BAD])],
    ["inboxes.listInboxesPage", (db) => R.inboxes.listInboxesPage(db, { status: "all", companyId: BAD, from: 0, to: 9 })],
    ["inboxes.listInboxesPage#yc", (db) => R.inboxes.listInboxesPage(db, { status: "all", ycloudAccountId: BAD, from: 0, to: 9 })],
    ["kanban.searchKanbanContactIds", (db) => R.kanban.searchKanbanContactIds(db, BAD, "%a%")],
    ["kanban.listTaggedConversationIds", (db) => R.kanban.listTaggedConversationIds(db, BAD, BAD, { assignee: "all", searchPattern: null, searchContactIds: null }, 0, 9)],
    ["kanban.listTaggedConversationIds#inbox", (db) => R.kanban.listTaggedConversationIds(db, s.company, s.tagKanban, { inboxId: BAD, assignee: "mine", userId: BAD, searchPattern: "%a%", searchContactIds: [BAD] }, 0, 9)],
    ["kanban.listKanbanColumnIds", (db) => R.kanban.listKanbanColumnIds(db, BAD)],
    ["kanban.listUntaggedConversationIds", (db) => R.kanban.listUntaggedConversationIds(db, BAD, [BAD], { assignee: "all", searchPattern: null, searchContactIds: null }, 0, 9)],
    ["kanban.listKanbanCardRows", (db) => R.kanban.listKanbanCardRows(db, [BAD])],
    ["kanban.listKanbanInboxes", (db) => R.kanban.listKanbanInboxes(db, BAD)],
    ["kanban.listKanbanColumns", (db) => R.kanban.listKanbanColumns(db, BAD)],
    ["memberships.listActiveMembersByRoleName", (db) => R.memberships.listActiveMembersByRoleName(db, "Agente", BAD)],
    ["memberships.listActiveMembershipsForSession", (db) => R.memberships.listActiveMembershipsForSession(db, BAD)],
    ["memberships.listMembershipsPage", (db) => R.memberships.listMembershipsPage(db, { companyId: BAD, status: "all", from: 0, to: 9 })],
    ["memberships.listMembershipsPage#ids", (db) => R.memberships.listMembershipsPage(db, { status: "all", userIds: [BAD], membershipIds: [BAD], from: 0, to: 9 })],
    ["memberships.listCompanyMembershipIds", (db) => R.memberships.listCompanyMembershipIds(db, BAD)],
    ["memberships.listMembershipIdsByRole", (db) => R.memberships.listMembershipIdsByRole(db, BAD)],
    ["messages.listConversationMessagesPage", (db) => R.messages.listConversationMessagesPage(db, BAD)],
    ["messages.listConversationMessagesPage#before", (db) => R.messages.listConversationMessagesPage(db, s.conversation, { ts: cutoff, id: BAD })],
    ["notes.listConversationNotes", (db) => R.notes.listConversationNotes(db, BAD)],
    ["roles.listCompanyRolesPage", (db) => R.roles.listCompanyRolesPage(db, { companyId: BAD, from: 0, to: 9 })],
    ["roles.listRolePermissionCodes", (db) => R.roles.listRolePermissionCodes(db, BAD)],
    ["tags.listCompanyContactTagIds", (db) => R.tags.listCompanyContactTagIds(db, BAD, [BAD])],
    ["tickets.listTicketsPage", (db) => R.tickets.listTicketsPage(db, { status: "all", priority: "all", createdBy: BAD }, 0, 9)],
    ["tickets.listTicketsPage#assignee", (db) => R.tickets.listTicketsPage(db, { status: "all", priority: "all", assigneeId: BAD }, 0, 9)],
    ["dashboard.countOpenConversations", (db) => R.dashboard.countOpenConversations(db, [BAD])],
    ["dashboard.countUnassignedOpenConversations", (db) => R.dashboard.countUnassignedOpenConversations(db, [BAD])],
    ["dashboard.countConversationsInsideWindow", (db) => R.dashboard.countConversationsInsideWindow(db, cutoff, [BAD])],
    ["dashboard.countConversationsOutsideWindow", (db) => R.dashboard.countConversationsOutsideWindow(db, cutoff, [BAD])],
    ["dashboard.countOpenConversationsInInbox", (db) => R.dashboard.countOpenConversationsInInbox(db, BAD)],
    ["dashboard.countContacts", (db) => R.dashboard.countContacts(db, [BAD])],
    ["dashboard.countMessagesSince", (db) => R.dashboard.countMessagesSince(db, "inbound", cutoff, [BAD])],
  ];
  // Updates and deletes on a bad id match nothing. They must not raise 8169 (the harness records it).
  const noOps: Array<[string, (db: any) => Promise<any>]> = [
    ["companies.updateCompanyById", (db) => R.companies.updateCompanyById(db, BAD, { name: "x", slug: "x", is_active: true, guid_company: null })],
    ["conversations.markConversationRead", (db) => R.conversations.markConversationRead(db, BAD)],
    ["conversations.setConversationAssignee", (db) => R.conversations.setConversationAssignee(db, BAD, null)],
    ["conversations.removeConversationTags", (db) => R.conversations.removeConversationTags(db, BAD, [BAD])],
    ["inboxes.assignInboxesToCompany", (db) => R.inboxes.assignInboxesToCompany(db, [BAD], s.company)],
    ["inboxes.unassignCompanyInboxes", (db) => R.inboxes.unassignCompanyInboxes(db, [BAD], BAD)],
    ["inboxes.updateInboxById", (db) => R.inboxes.updateInboxById(db, BAD, { name: "x", is_active: true })],
    ["memberships.updateMembershipActive", (db) => R.memberships.updateMembershipActive(db, BAD, true)],
    ["memberships.deleteMembershipRoles", (db) => R.memberships.deleteMembershipRoles(db, BAD)],
    ["memberships.deleteMembershipInboxes", (db) => R.memberships.deleteMembershipInboxes(db, BAD)],
    ["memberships.deleteMembershipInboxLinks", (db) => R.memberships.deleteMembershipInboxLinks(db, [BAD], [BAD])],
    ["messaging.updateConversationLastMessage", (db) => R.messaging.updateConversationLastMessage(db, BAD, { unread_count: 0 })],
    ["messaging.updateMessageBodyIfUnchanged", (db) => R.messaging.updateMessageBodyIfUnchanged(db, BAD, "x", { body: "y" })],
    ["messaging.updateConversationPreviewIfUnchanged", (db) => R.messaging.updateConversationPreviewIfUnchanged(db, BAD, "x", "y", cutoff)],
    ["notes.removeConversationNote", (db) => R.notes.removeConversationNote(db, BAD, BAD)],
    ["profiles.updateProfileFullName", (db) => R.profiles.updateProfileFullName(db, BAD, "x")],
    ["roles.updateCompanyRole", (db) => R.roles.updateCompanyRole(db, BAD, BAD, { name: "x", description: null })],
    ["roles.deleteRolePermissionsByRole", (db) => R.roles.deleteRolePermissionsByRole(db, BAD)],
    ["tags.updateContactTagById", (db) => R.tags.updateContactTagById(db, BAD, { name: "x", color: "x" })],
    ["tags.deleteContactTagById", (db) => R.tags.deleteContactTagById(db, BAD)],
    ["tags.deleteContactTagLinks", (db) => R.tags.deleteContactTagLinks(db, BAD)],
    ["tags.updateContactDetails", (db) => R.tags.updateContactDetails(db, BAD, { name: "x", phone_number: "x" })],
    ["tickets.setTicketStatus", (db) => R.tickets.setTicketStatus(db, BAD, "open")],
    ["tickets.setTicketContent", (db) => R.tickets.setTicketContent(db, BAD, { title: "x", description: "x", priority: "low" })],
    ["tickets.setTicketAssignee", (db) => R.tickets.setTicketAssignee(db, BAD, null)],
    ["tickets.setTicketSupportResponse", (db) => R.tickets.setTicketSupportResponse(db, BAD, { body: "x", respondedAt: cutoff, respondedBy: NIL })],
    ["errors.updateErrorLog", (db) => R.errors.updateErrorLog(db, BAD, { status: "open" })],
    ["ycloud.saveYCloudAccountWebhook", (db) => R.ycloud.saveYCloudAccountWebhook(db, BAD, { name: "x" })],
    ["ycloud.updateSyncedInbox", (db) => R.ycloud.updateSyncedInbox(db, BAD, { name: "x" })],
  ];
  // Values a uuid column can't take, in the body of a write: an error, and a readable one.
  const badValues: Array<[string, (db: any) => Promise<any>]> = [
    ["companies.insertCompany", null as any],
    ["conversations.addConversationTag", (db) => R.conversations.addConversationTag(db, BAD, BAD)],
    ["conversations.addConversationTag#tag", (db) => R.conversations.addConversationTag(db, s.conversation, BAD)],
    ["conversations.upsertContactByPhone", (db) => R.conversations.upsertContactByPhone(db, { companyId: BAD, phoneNumber: "x", name: "x" })],
    ["conversations.upsertOpenConversation", (db) => R.conversations.upsertOpenConversation(db, { companyId: BAD, inboxId: BAD, contactId: BAD, assigneeId: BAD })],
    ["conversations.setConversationAssignee#value", (db) => R.conversations.setConversationAssignee(db, NIL, BAD)],
    ["inboxes.assignInboxesToCompany#value", (db) => R.inboxes.assignInboxesToCompany(db, [NIL], BAD)],
    ["memberships.insertMembership", (db) => R.memberships.insertMembership(db, { company_id: BAD, user_id: BAD, is_active: true })],
    ["memberships.insertMembershipRole", (db) => R.memberships.insertMembershipRole(db, { membership_id: BAD, role_id: BAD })],
    ["memberships.insertMembershipInboxes", (db) => R.memberships.insertMembershipInboxes(db, [{ membership_id: BAD, inbox_id: BAD }])],
    ["messaging.insertMessage", (db) => R.messaging.insertMessage(db, { conversation_id: BAD, company_id: BAD, direction: "inbound" })],
    ["messaging.updateConversationLastMessage#value", (db) => R.messaging.updateConversationLastMessage(db, NIL, { assignee_id: BAD })],
    ["notes.insertConversationNote", (db) => R.notes.insertConversationNote(db, { conversationId: BAD, companyId: BAD, authorId: BAD, body: "x" })],
    ["roles.insertRole", (db) => R.roles.insertRole(db, { company_id: BAD, name: "x", description: null, is_system: false })],
    ["roles.insertRolePermissionRows", (db) => R.roles.insertRolePermissionRows(db, [{ role_id: BAD, permission_id: BAD }])],
    ["tags.insertTag", (db) => R.tags.insertTag(db, { company_id: BAD, name: "x", color: "x", position: 0, is_kanban_column: false })],
    ["tags.insertTags", (db) => R.tags.insertTags(db, [{ company_id: BAD, name: "x", color: "x", position: 0, is_kanban_column: false }])],
    ["tags.insertContactTagLinks", (db) => R.tags.insertContactTagLinks(db, [{ contact_id: BAD, tag_id: BAD }])],
    ["tickets.insertTicket", (db) => R.tickets.insertTicket(db, { companyId: BAD, conversationId: BAD, title: "x", description: "x", priority: "low", createdBy: BAD })],
    ["tickets.setTicketAssignee#value", (db) => R.tickets.setTicketAssignee(db, NIL, BAD)],
    ["errors.insertErrorLog", (db) => R.errors.insertErrorLog(db, { source: `${PREFIX}x`, message: "x", company_id: BAD })],
    ["ycloud.assignYCloudAccountToUnlinkedInboxes", (db) => R.ycloud.assignYCloudAccountToUnlinkedInboxes(db, BAD)],
    ["ycloud.insertSyncedInbox", (db) => R.ycloud.insertSyncedInbox(db, { name: `${PREFIX}x`, phone_number: `${PREFIX}x`, company_id: BAD })],
  ].filter(([, f]) => f) as Array<[string, (db: any) => Promise<any>]>;

  for (const db of users) {
    const who = db.actor.kind === "system" ? "system" : (db.actor as any).userId === BAD ? "bad-user" : "user";
    for (const [fn, call] of single) {
      const r = await call(db);
      check(`${fn}@${who}`, `bad id: no_rows, got ${r.error?.code ?? "data"}`, r.error?.code === "PGRST116");
    }
    for (const [fn, call] of maybe) {
      const r = await call(db);
      check(`${fn}@${who}`, `bad id: null, got ${r.error?.code ?? "data"}`, !r.error && r.data === null);
    }
    for (const [fn, call] of lists) {
      const r = await call(db);
      check(`${fn}@${who}`, `bad id: empty, got ${r.error?.code ?? `${r.data?.length} rows`}`, !r.error && (r.data ?? []).length === 0 || fn.endsWith("#exclude"));
    }
    for (const [fn, call] of noOps) {
      const r = await call(db);
      check(`${fn}@${who}`, `bad id: no-op, got ${r.error?.code ?? "ok"}`, !r.error);
    }
    for (const [fn, call] of badValues) {
      const r = await call(db);
      const acceptable = !r.error || r.error.code === "22P02" || isRls(r);
      check(`${fn}@${who}`, `bad value: 22P02, the RLS error, or nothing done; got ${r.error?.code ?? "ok"}`, acceptable);
    }
  }

  // Uppercase ids reach the same rows: Postgres compares uuids by value.
  const up = (id: string) => id.toUpperCase();
  const user = userSqlDb(s.memberUser);
  check("conversations.getConversationCompany", "uppercase id, user", !(await R.conversations.getConversationCompany(user, up(s.conversation))).error);
  check("messaging.getConversationForSending", "uppercase id", !(await R.messaging.getConversationForSending(sys, up(s.conversation))).error);
  check("memberships.listActiveMembershipsForSession", "uppercase id", ((await R.memberships.listActiveMembershipsForSession(sys, up(s.memberUser))).data?.length ?? 0) > 0);

  // `.single()` with several rows. The conversation table has no way to produce this by key, so
  // listActive... stands for lists, and maybeOne/one are tested directly.
  const { maybeOne, one } = await import("@/lib/db/sqlserver/db");
  const two = async () => [{ id: 1 }, { id: 2 }];
  check("db.one", "several rows: error", (await one(two)).error?.code === "PGRST116");
  check("db.maybeOne", "several rows: error", (await maybeOne(two)).error?.code === "PGRST116");
  check("db.one", "none: error", (await one(async () => [])).error?.code === "PGRST116");
  check("db.maybeOne", "none: null", (await maybeOne(async () => [])).data === null);
  check("db.one", "one: the row", (await one(async () => [{ id: 1 }])).data !== null);

  // Search text with characters T-SQL reads as wildcards, compared with Postgres.
  const searches = ["[a]", "a]", "a%b", "50%", "a_b", "á", "😀", "O'Brien", "ñ", "Á"];
  for (const q of searches) {
    const a = await R.contacts.listContactIdsPage(sb, { scopedCompanyIds: null, companyId: "", contactIds: null, q, from: 0, to: 999 });
    const b = await R.contacts.listContactIdsPage(sys, { scopedCompanyIds: null, companyId: "", contactIds: null, q, from: 0, to: 999 });
    if (a.error || b.error) {
      fail("contacts.listContactIdsPage#search", `${q.length}-char search: supabase=${a.error?.code ?? "ok"} sql=${b.error?.code ?? "ok"}`);
      continue;
    }
    await compareRows({ fn: "contacts.listContactIdsPage", variant: `chars-${hash(q)}`, table: "contacts", limit: 1000, call: async () => null }, a.data, b.data);
    const c = await R.profiles.searchProfileIds(sb, `%${q}%`);
    const d = await R.profiles.searchProfileIds(sys, `%${q}%`);
    if (!c.error && !d.error) await compareRows({ fn: "profiles.searchProfileIds", variant: `chars-${hash(q)}`, table: "profiles", call: async () => null }, c.data, d.data);
    const e = await R.kanban.searchKanbanContactIds(sb, s.company, ilikePattern(q));
    const f = await R.kanban.searchKanbanContactIds(sys, s.company, ilikePattern(q));
    if (!e.error && !f.error) await compareRows({ fn: "kanban.searchKanbanContactIds", variant: `chars-${hash(q)}`, table: "contacts", call: async () => null }, e.data, f.data);
  }

  // Collations: every text list against every kind of column.
  const collation = await Promise.all([
    R.roles.listPermissionsByCodes(sys, ["conversations.view", "😀"]),
    R.conversations.listContactsByPhoneNumbers(sys, s.company, [s.contactPhone, "😀"]),
    R.messaging.listEnrichableMessagesByYCloudIds(sys, [s.ycloudMessageId, "😀"]),
    R.messaging.updateMessagesMediaByYCloudIds(sys, ["pm-none-😀"], { media_url: "no" }),
    R.conversations.findCompanyByGuid(sys, "😀"),
    R.conversations.findActiveMembershipWithRole(sys, s.memberUser, s.company, "😀"),
    R.memberships.listActiveMembersByRoleName(sys, "😀"),
  ]);
  collation.forEach((r, i) => check("collation", `text list ${i}: no error, got ${r.error?.code ?? "ok"}`, !r.error));
}

// ---------------------------------------------------------------------------------------------

function coverage() {
  const rows = [...hits.entries()];
  const sqlRun = rows.filter(([, h]) => h.system + h.user > 0);
  const missing = rows.filter(([name, h]) => h.system + h.user === 0 && !NOT_EXERCISED[name]);
  const systemOnly = rows.filter(([name, h]) => h.user === 0 && h.system > 0 && !NOT_EXERCISED[name]);
  return { total: rows.length, sqlRun: sqlRun.length, missing: missing.map(([n]) => n), systemOnly: systemOnly.map(([n]) => n) };
}

async function main() {
  const wanted = process.argv.slice(2);
  const runs = (name: string) => wanted.length === 0 || wanted.includes(name);
  const started = Date.now();

  await loadSnapshots();
  const [latest] = await sys.run(sql`
    SELECT TOP (1) created_at FROM chatbase.messages
    WHERE created_at < SYSUTCDATETIME() ORDER BY created_at DESC`);
  cutoff = latest?.created_at as string;

  const seedCompanies = await sys.run(sql`
    SELECT c.id, COUNT(cv.id) AS n
    FROM chatbase.companies c
    LEFT JOIN chatbase.conversations cv ON cv.company_id = c.id
    WHERE c.slug NOT LIKE ${`${PREFIX}%`}
    GROUP BY c.id ORDER BY n DESC`);
  const seeds: Seed[] = [];
  for (const row of seedCompanies) {
    seeds.push(await buildSeed(row.id as string));
  }
  console.log(`seeds: ${seeds.length} companies, ${seeds.filter((s) => s.conversation !== NIL).length} with stable conversations`);

  if (runs("reads")) await runReads(seeds);
  if (runs("users")) await runUsers(seeds);
  if (runs("writes")) await runWrites(seeds);
  if (runs("errors")) await runErrors(seeds);

  const cov = coverage();
  const byFn = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `[${finding.section}] ${finding.fn}`;
    byFn.set(key, [...(byFn.get(key) ?? []), finding]);
  }
  console.log("\n== differences ==");
  for (const [key, list] of byFn) {
    const whats = new Map<string, number>();
    for (const f of list) {
      const short = f.what.replace(/ \(row [0-9a-f]{8}\)$/, "").replace(/\([0-9a-f]{8}\)$/, "");
      whats.set(short, (whats.get(short) ?? 0) + 1);
    }
    console.log(key);
    for (const [what, n] of whats) console.log(`   ${n > 1 ? `${n}x ` : ""}${what}`);
  }
  console.log("\n== explained ==");
  for (const [kind, n] of explained) console.log(`  ${n}  ${kind}`);
  for (const note of notes_) console.log(`  note: ${note}`);
  console.log("\n== slow (over 1 s) ==");
  const worst = new Map<string, { ms: number; actor: string; n: number }>();
  for (const s of slow) {
    const prior = worst.get(`${s.fn}@${s.actor}`);
    worst.set(`${s.fn}@${s.actor}`, { ms: Math.max(prior?.ms ?? 0, s.ms), actor: s.actor, n: (prior?.n ?? 0) + 1 });
  }
  for (const [fn, w] of [...worst.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${w.ms} ms (${w.n}x) ${fn}`);
  }
  console.log("\n== forbidden SQL errors ==");
  console.log(forbidden.length ? JSON.stringify(forbidden.slice(0, 40)) : "  none");
  console.log("\n== coverage ==");
  console.log(`  ${cov.sqlRun}/${cov.total} functions executed on SQL Server`);
  if (cov.missing.length) console.log(`  not executed: ${cov.missing.join(", ")}`);
  if (cov.systemOnly.length) console.log(`  system only: ${cov.systemOnly.join(", ")}`);
  for (const [name, why] of Object.entries(NOT_EXERCISED)) console.log(`  on purpose not run: ${name}: ${why}`);
  console.log(`\n${checks} checks, ${findings.length} differences, ${forbidden.length} forbidden errors, ${Math.round((Date.now() - started) / 1000)} s`);

  if (process.env.COMPARE_OUT) {
    writeFileSync(process.env.COMPARE_OUT, JSON.stringify({ findings, explained: [...explained], slow, forbidden }, null, 1));
  }
  process.exit(findings.length || forbidden.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`aborted: ${(err as Error).message?.slice(0, 500)}`);
  process.exit(2);
});
