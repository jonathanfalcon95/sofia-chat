// Differential test of the SQL Server port of process_ycloud_event. Webhooks received after the copy
// was loaded went only to Supabase, so replaying them on the copy must reproduce Supabase's rows.
//
//   npx -y tsx scripts/migrate/replay-events.ts prepare --state <file> --since <iso> [--until <iso>]
//   npx -y tsx scripts/migrate/replay-events.ts replay  --state <file>
//   npx -y tsx scripts/migrate/replay-events.ts compare --state <file>
//   npx -y tsx scripts/migrate/replay-events.ts reset   --state <file> --confirm <database>
//   npx -y tsx scripts/migrate/replay-events.ts concurrency --confirm <database>
//   npx -y tsx scripts/migrate/replay-events.ts rollback    --confirm <database>
//
// `prepare` saves the copy's rows the window will touch, so `reset` can put them back and the replay
// can be repeated after a fix: Supabase only knows the state after the events, not the one before.
// The state file holds customer data: keep it out of the repository and delete it when done.
//
// Reads DATABASE_URL, SQL_SERVER, SQL_DB, SQL_USER and SQL_PASSWORD. Supabase is only ever read, in
// a read-only transaction. Output is counts, event types, field names and value shapes, never values.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { execute, type Row } from "../../src/lib/db/sqlserver/connection.ts";
import { inTransaction, systemSqlDb, type SqlDb } from "../../src/lib/db/sqlserver/db.ts";
import { updateMessagesMediaByYCloudIds } from "../../src/lib/db/sqlserver/repos/messaging.ts";
import { join, raw, sql, textList, uuidList, type SqlFragment, type SqlValue } from "../../src/lib/db/sqlserver/sql.ts";
import { applyYCloudEvent, DuplicateEvent, processYCloudEvent } from "../../src/lib/db/sqlserver/webhook.ts";
import { extractInboundMedia } from "../../src/lib/media.ts";
import { extractReplyText } from "../../src/lib/ycloud/inbound-message-display.ts";

const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (name: string) => {
  const value = option(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
const confirmDatabase = () => {
  if (option("confirm") !== process.env.SQL_DB) throw new Error("Pass --confirm with the database name");
};

// Tables ---------------------------------------------------------------------

const JSON_COLUMNS = new Set(["metadata", "raw_payload", "reactions", "template_components"]);
const CONTACT_COLUMNS = ["id", "company_id", "phone_number", "name", "metadata", "created_at", "updated_at"];
const CONVERSATION_COLUMNS = [
  "id", "company_id", "inbox_id", "contact_id", "assignee_id", "status", "last_message_at", "last_inbound_at",
  "window_expires_at", "last_message_preview", "unread_count", "created_at", "updated_at",
];
const TAG_COLUMNS = ["conversation_id", "tag_id", "created_at"];
const MESSAGE_COLUMNS = [
  "id", "conversation_id", "company_id", "direction", "type", "body", "template_name", "template_language",
  "template_components", "ycloud_message_id", "status", "media_url", "raw_payload", "sent_by", "created_at",
  "media_mime", "media_filename", "media_sha256", "wamid", "reply_to_wamid", "reactions",
];

/** Aliased so connection.ts leaves the JSON as stored, exact text included. */
const copyColumns = (columns: string[]) =>
  raw(columns.map((c) => (JSON_COLUMNS.has(c) ? `[${c}] AS [${c}__text]` : `[${c}]`)).join(", "));

const TIMESTAMP_COLUMNS = new Set([
  "created_at", "updated_at", "last_message_at", "last_inbound_at", "window_expires_at", "processed_at",
]);

/** UTC with microseconds, jsonb as text: the driver's Date and JSON.parse would decide too much. */
function pgColumns(columns: string[], alias = "") {
  return columns
    .map((c) => {
      if (JSON_COLUMNS.has(c)) return `${alias}"${c}"::text as "${c}__text"`;
      if (TIMESTAMP_COLUMNS.has(c)) {
        return `to_char(${alias}"${c}" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "${c}"`;
      }
      return `${alias}"${c}"`;
    })
    .join(", ");
}

function parsed(row: Row, column: string): unknown {
  const text = row[`${column}__text`] as string | null;
  return text === null || text === undefined ? null : JSON.parse(text);
}

// Supabase, read only --------------------------------------------------------

async function withSupabase<T>(work: (query: (text: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>) {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/, ""),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const result = await work(async (text, params) => (await client.query(text, params as unknown[])).rows);
    await client.query("rollback");
    return result;
  } finally {
    await client.end();
  }
}

type SupabaseQuery = Parameters<Parameters<typeof withSupabase>[0]>[0];

type ListedEvent = { id: string; eventId: string; eventType: string; processedAt: string };
type WindowEvent = ListedEvent & { payload: Record<string, unknown> };

/**
 * The table has no index on processed_at: the list leaves the payload out, so its sort holds short
 * rows, and payloads come afterwards by primary key, a few at a time, with no sort at all.
 */
async function listEvents(query: SupabaseQuery, since: string, until: string | null): Promise<ListedEvent[]> {
  const rows = await query(
    `select id, ycloud_event_id, event_type,
            to_char(processed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as processed_at
     from public.webhook_events
     where processed_at > $1::timestamptz and ($2::timestamptz is null or processed_at <= $2::timestamptz)
     order by processed_at, id`,
    [since, until],
  );
  return rows.map((r) => ({
    id: r.id as string,
    eventId: r.ycloud_event_id as string,
    eventType: r.event_type as string,
    processedAt: r.processed_at as string,
  }));
}

async function* withPayloads(query: SupabaseQuery, events: ListedEvent[], batch = 25): AsyncGenerator<WindowEvent> {
  for (let i = 0; i < events.length; i += batch) {
    const part = events.slice(i, i + batch);
    const rows = await query(`select id, payload::text as payload_text from public.webhook_events where id = any($1::uuid[])`, [
      part.map((e) => e.id),
    ]);
    const payloads = new Map(rows.map((r) => [r.id as string, r.payload_text as string]));
    for (const event of part) {
      const text = payloads.get(event.id);
      if (text === undefined) throw new Error("Event disappeared from Supabase during the read");
      yield { ...event, payload: JSON.parse(text) };
    }
  }
}

/** Microseconds to the millisecond the copy keeps: both sides drop the digits the same way. */
function toMillis(micros: string | null): string | null {
  return micros === null ? null : `${micros.slice(0, 23)}Z`;
}

// What an event can touch ----------------------------------------------------

type Keys = { messages: Set<string>; phones: Set<string> };

function str(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function addKeys(keys: Keys, payload: Record<string, unknown>) {
  const msg = (payload.whatsappInboundMessage ?? payload.whatsappMessage) as Record<string, any> | null | undefined;
  if (!msg || typeof msg !== "object") return;
  const addMessage = (value: unknown) => {
    const text = str(value);
    if (text) keys.messages.add(text);
  };
  const addPhone = (value: unknown) => {
    const text = str(value);
    if (text) keys.phones.add(text);
  };
  addMessage(msg.id);
  addMessage(msg.wamid);
  addPhone(msg.from);
  addPhone(msg.to);
  if (msg.type === "reaction" || msg.type === "revoke") {
    const block = msg[msg.type];
    addMessage(block?.message_id);
    addMessage(block?.wamid);
    addMessage(msg.context?.message_id);
    addMessage(msg.context?.id);
    addMessage(msg.context?.wamid);
  }
  const system = msg.type === "system" ? msg.system : msg.type === "edit" ? msg.edit?.message?.system : null;
  if (system?.wa_id) addPhone(`+${String(system.wa_id).replace(/^\+/, "")}`);
}

// State file -----------------------------------------------------------------

type State = {
  since: string;
  until: string;
  messageKeys: string[];
  phones: string[];
  preimage: { contacts: Row[]; conversations: Row[]; tags: Row[]; messages: Row[] };
};

const readState = (path: string) => JSON.parse(readFileSync(path, "utf8")) as State;

const inChunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function copyContacts(phones: string[]) {
  return execute(sql`SELECT ${copyColumns(CONTACT_COLUMNS)} FROM chatbase.contacts WHERE phone_number IN ${textList(phones)}`);
}
async function copyConversations(contactIds: string[]) {
  return execute(sql`SELECT ${copyColumns(CONVERSATION_COLUMNS)} FROM chatbase.conversations WHERE contact_id IN ${uuidList(contactIds)}`);
}
async function copyTags(conversationIds: string[]) {
  return execute(sql`SELECT ${copyColumns(TAG_COLUMNS)} FROM chatbase.conversation_tags WHERE conversation_id IN ${uuidList(conversationIds)}`);
}
/** One indexed lookup per key column: an OR over two OPENJSON lists scans the whole table. */
async function copyMessages(keys: string[]) {
  const found = new Map<string, Row>();
  for (const part of inChunks(keys, 100)) {
    for (const column of ["ycloud_message_id", "wamid"]) {
      const rows = await execute(sql`SELECT ${copyColumns(MESSAGE_COLUMNS)} FROM chatbase.messages
                                     WHERE ${raw(column)} IN (SELECT CAST([value] AS nvarchar(256)) COLLATE Latin1_General_100_BIN2 FROM OPENJSON(${JSON.stringify(part)}))
                                     OPTION (RECOMPILE)`);
      for (const row of rows) found.set(row.id as string, row);
    }
  }
  return [...found.values()];
}

/** Saves the copy's rows for keys not seen before, so a window can grow between runs. */
async function prepare() {
  const path = need("state");
  let previous: State | null = null;
  try {
    previous = readState(path);
  } catch {
    previous = null;
  }
  const since = previous?.since ?? need("since");
  const { until, events, keys } = await withSupabase(async (query) => {
    const [{ now }] = await query("select to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') as now");
    const until = option("until") ?? `${now as string}Z`;
    const events = await listEvents(query, since, until);
    const keys: Keys = { messages: new Set(), phones: new Set() };
    for await (const event of withPayloads(query, events)) addKeys(keys, event.payload);
    return { until, events, keys };
  });
  const knownMessages = new Set(previous?.messageKeys ?? []);
  const knownPhones = new Set(previous?.phones ?? []);
  const newMessages = [...keys.messages].filter((k) => !knownMessages.has(k));
  const newPhones = [...keys.phones].filter((k) => !knownPhones.has(k));

  const contacts = await copyContacts(newPhones);
  const conversations = await copyConversations(contacts.map((c) => c.id as string));
  const tags = await copyTags(conversations.map((c) => c.id as string));
  const messages = await copyMessages(newMessages);
  const preimage = previous?.preimage ?? { contacts: [], conversations: [], tags: [], messages: [] };
  const seen = new Set(preimage.messages.map((m) => m.id));
  const state: State = {
    since,
    until,
    messageKeys: [...knownMessages, ...newMessages],
    phones: [...knownPhones, ...newPhones],
    preimage: {
      contacts: [...preimage.contacts, ...contacts],
      conversations: [...preimage.conversations, ...conversations],
      tags: [...preimage.tags, ...tags],
      messages: [...preimage.messages, ...messages.filter((m) => !seen.has(m.id))],
    },
  };
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  console.log(JSON.stringify({
    events: events.length,
    messageKeys: state.messageKeys.length,
    phones: state.phones.length,
    preimage: {
      contacts: state.preimage.contacts.length,
      conversations: state.preimage.conversations.length,
      tags: state.preimage.tags.length,
      messages: state.preimage.messages.length,
    },
  }, null, 2));
}

function assignments(row: Row, columns: string[]): SqlFragment {
  return join(
    columns.map((column) => {
      const value = (JSON_COLUMNS.has(column) ? row[`${column}__text`] : row[column]) as SqlValue;
      return sql`${raw(`[${column}]`)} = ${value ?? null}`;
    }),
    ", ",
  );
}

/** Puts the copy back as `prepare` saved it. Touches only rows reachable from the window's keys. */
async function reset() {
  confirmDatabase();
  const state = readState(need("state"));
  const { contacts, conversations, tags, messages } = state.preimage;
  const eventsGone = await withSupabase(async (query) => {
    const events = await listEvents(query, state.since, state.until);
    for (const part of inChunks(events, 200)) {
      await execute(sql`DELETE FROM chatbase.webhook_events WHERE ycloud_event_id IN ${textList(part.map((e) => e.eventId))}`);
    }
    return events.length;
  });
  const messageIds = messages.map((m) => m.id as string);
  const conversationIds = conversations.map((c) => c.id as string);
  const contactIds = contacts.map((c) => c.id as string);
  const saved = new Set(messageIds);
  const created = (await copyMessages(state.messageKeys)).map((m) => m.id as string).filter((id) => !saved.has(id));
  for (const part of inChunks(created, 200)) {
    await execute(sql`DELETE FROM chatbase.messages WHERE id IN ${uuidList(part)}`);
  }
  await execute(sql`DELETE FROM chatbase.conversations
                    WHERE contact_id IN (SELECT id FROM chatbase.contacts WHERE phone_number IN ${textList(state.phones)})
                      AND id NOT IN ${uuidList(conversationIds)}`);
  await execute(sql`DELETE FROM chatbase.contacts
                    WHERE phone_number IN ${textList(state.phones)} AND id NOT IN ${uuidList(contactIds)}`);
  const contactSet = CONTACT_COLUMNS.filter((c) => c !== "id");
  for (const row of contacts) {
    await execute(sql`UPDATE chatbase.contacts SET ${assignments(row, contactSet)} WHERE id = ${row.id as string}`);
  }
  const conversationSet = CONVERSATION_COLUMNS.filter((c) => c !== "id");
  for (const row of conversations) {
    await execute(sql`UPDATE chatbase.conversations SET ${assignments(row, conversationSet)} WHERE id = ${row.id as string}`);
  }
  await execute(sql`DELETE FROM chatbase.conversation_tags WHERE conversation_id IN ${uuidList(conversationIds)}`);
  for (const row of tags) {
    await execute(sql`INSERT INTO chatbase.conversation_tags (conversation_id, tag_id, created_at)
                      VALUES (${row.conversation_id as string}, ${row.tag_id as string}, ${row.created_at as string})`);
  }
  const messageSet = MESSAGE_COLUMNS.filter((c) => c !== "id");
  for (const row of messages) {
    await execute(sql`UPDATE chatbase.messages SET ${assignments(row, messageSet)} WHERE id = ${row.id as string}`);
  }
  const byKey = (rows: Row[], key: (row: Row) => string) => new Map(rows.map((row) => [key(row), row]));
  const unchanged = (saved: Row[], now: Row[], key: (row: Row) => string) => {
    const current = byKey(now, key);
    return saved.length === now.length && saved.every((row) => isDeepStrictEqual(row, current.get(key(row))));
  };
  const byId = (row: Row) => row.id as string;
  const restored = {
    contacts: unchanged(contacts, await copyContacts(state.phones), byId),
    conversations: unchanged(conversations, await copyConversations(contactIds), byId),
    tags: unchanged(tags, await copyTags(conversationIds), (row) => `${row.conversation_id}|${row.tag_id}`),
    messages: unchanged(messages, await copyMessages(state.messageKeys), byId),
  };
  console.log(JSON.stringify({ eventsRemoved: eventsGone, restored }));
}

// Replay ---------------------------------------------------------------------

/** Error kinds without values: SQL Server quotes key values in its messages. */
function errorKind(err: unknown): string {
  const e = err as { number?: number; code?: string; name?: string };
  if (e?.number !== undefined) return `sql_${e.number}`;
  return e?.code ? `${e.name ?? "Error"}_${e.code}` : (e?.name ?? "Error");
}

function resultKind(result: Record<string, unknown>): string {
  if (result.duplicate) return "duplicate";
  if (result.skipped) return `skipped:${String(result.skipped)}`;
  if (result.ignored) return "ignored";
  if (result.reaction) return result.direction === "outbound" ? "reaction_outbound" : "reaction_inbound";
  if ("revoked" in result) return "revoked";
  if (result.updated) return "updated";
  if (result.conversation_id) return "conversation";
  return "other";
}

function bump(tally: Record<string, number>, key: string, by = 1) {
  tally[key] = (tally[key] ?? 0) + by;
}

/** enrichInboundMedia in src/lib/ycloud/webhook-handler.ts, which production runs after the RPC. */
async function enrichInboundMedia(db: SqlDb, payload: Record<string, unknown>) {
  const msg = (payload.whatsappInboundMessage || payload.whatsappMessage) as Record<string, unknown> | undefined;
  if (!msg) return false;
  const media = extractInboundMedia(msg);
  const ids = [msg.id, msg.wamid].map((v) => (v == null ? "" : String(v))).filter(Boolean);
  if (!media?.mediaUrl || ids.length === 0) return false;
  const { error } = await updateMessagesMediaByYCloudIds(db, ids, {
    type: media.type,
    body: media.body,
    media_url: media.mediaUrl,
    media_mime: media.mediaMime,
    media_filename: media.mediaFilename,
    media_sha256: media.mediaSha256,
  });
  if (error) throw Object.assign(new Error("media enrich failed"), { code: error.code });
  return true;
}

function percentile(sorted: number[], p: number) {
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function timings(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), worst: sorted.at(-1) ?? null };
}

async function replay() {
  const state = readState(need("state"));
  const db = systemSqlDb();
  const results: Record<string, number> = {};
  const resultsByMessageType: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byMessageType: Record<string, number> = {};
  const rpcMs: number[] = [];
  const enrichedMs: number[] = [];
  let already = 0;
  let replayed = 0;
  let enriched = 0;
  await withSupabase(async (query) => {
    const events = await listEvents(query, state.since, state.until);
    const present = new Set<string>();
    for (const part of inChunks(events, 200)) {
      const rows = await execute(sql`SELECT ycloud_event_id FROM chatbase.webhook_events WHERE ycloud_event_id IN ${textList(part.map((e) => e.eventId))}`);
      for (const r of rows) present.add(r.ycloud_event_id as string);
    }
    already = present.size;
    const pending = events.filter((e) => !present.has(e.eventId));
    for await (const event of withPayloads(query, pending)) {
      const msg = (event.payload.whatsappInboundMessage ?? event.payload.whatsappMessage) as Record<string, unknown> | undefined;
      bump(byType, event.eventType);
      bump(byMessageType, String(msg?.type ?? "none"));
      const now = new Date(toMillis(event.processedAt) as string);
      const started = performance.now();
      try {
        const result = await processYCloudEvent(db, event.eventId, event.eventType, event.payload, { now });
        rpcMs.push(Math.round(performance.now() - started));
        bump(results, resultKind(result));
        bump(resultsByMessageType, `${String(msg?.type ?? "none")}|${event.eventType}|${resultKind(result)}`);
        replayed += 1;
      } catch (err) {
        bump(errors, `${event.eventType}|${String(msg?.type ?? "none")}|${errorKind(err)}`);
        continue;
      }
      const enrichStart = performance.now();
      try {
        if (await enrichInboundMedia(db, event.payload)) {
          enriched += 1;
          enrichedMs.push(Math.round(performance.now() - enrichStart));
        }
      } catch (err) {
        bump(errors, `enrich|${errorKind(err)}`);
      }
    }
  });
  console.log(JSON.stringify({ alreadyInCopy: already, replayed, byType, byMessageType, results, resultsByMessageType, errors, enriched, rpcMs: timings(rpcMs), enrichMs: timings(enrichedMs) }, null, 2));
}

// Compare --------------------------------------------------------------------

const SAFE_VALUE_COLUMNS = new Set(["direction", "type", "status"]);

function shape(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  return typeof value;
}

function jsonPaths(a: unknown, b: unknown, path = "$", found: string[] = []): string[] {
  if (found.length >= 12 || isDeepStrictEqual(a, b)) return found;
  const bothObjects = typeof a === "object" && a !== null && typeof b === "object" && b !== null;
  if (bothObjects && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) {
      const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^\d+$/.test(key) ? key : "<key>";
      jsonPaths((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${safe}`, found);
    }
    return found;
  }
  found.push(`${path}: supabase ${shape(a)}, copy ${shape(b)}`);
  return found;
}

/** Stable handle to look a row up again, without showing its id. */
const handle = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 10);

type Difference = { table: string; column: string; kind: string; row: string; context?: string; detail?: string };

class Report {
  readonly differences: Difference[] = [];
  readonly compared: Record<string, number> = {};
  readonly equalRows: Record<string, number> = {};
  readonly excluded: Record<string, number> = {};

  add(difference: Difference) {
    this.differences.push(difference);
  }

  summary(detailKinds: Set<string>) {
    const byKind: Record<string, number> = {};
    for (const d of this.differences) bump(byKind, `${d.kind}|${d.table}.${d.column}`);
    const details = this.differences.filter((d) => detailKinds.has(d.kind)).slice(0, 60);
    return { compared: this.compared, equalRows: this.equalRows, excluded: this.excluded, byKind, details };
  }
}

/** Equal, or within the millisecond Supabase's extra digits can round to. Otherwise the delta. */
function compareTimestamp(supabase: string | null, copy: string | null) {
  if (supabase === null || copy === null) return supabase === copy ? "equal" : "different";
  const a = new Date(toMillis(supabase) as string).getTime();
  const b = new Date(copy).getTime();
  if (a === b) return "equal";
  const hasMicros = !supabase.endsWith("000");
  return hasMicros && Math.abs(a - b) <= 1 ? "submillisecond" : "different";
}

function timestampDelta(supabase: string | null, copy: string | null) {
  if (supabase === null || copy === null) return `supabase ${shape(supabase)}, copy ${shape(copy)}`;
  return `copy minus supabase ${new Date(copy).getTime() - new Date(toMillis(supabase) as string).getTime()} ms`;
}

const isPlaceholderText = (body: unknown) =>
  typeof body === "string" && (/^\[[a-z_]+\]$/.test(body) || body === "Mensaje interactivo");

/** enrichMessageTextFromWebhook runs after the response and needs YCloud's template definitions. */
function isTextEnrichment(supabase: Row, copy: Row) {
  if (!isPlaceholderText(copy.body)) return false;
  if (supabase.type === "template") return true;
  if (supabase.type !== "button" && supabase.type !== "interactive") return false;
  return extractReplyText(parsed(supabase, "raw_payload") as never) === supabase.body;
}

function compareColumns(
  report: Report,
  table: string,
  columns: string[],
  supabase: Row,
  copy: Row,
  classify: (column: string) => string | null,
  context: string,
) {
  let equal = true;
  const row = handle(String(supabase.id ?? copy.id ?? `${supabase.conversation_id}|${supabase.tag_id}`));
  for (const column of columns) {
    if (JSON_COLUMNS.has(column)) {
      const a = parsed(supabase, column);
      const b = parsed(copy, column);
      if (isDeepStrictEqual(a, b)) continue;
      equal = false;
      report.add({ table, column, row, context, kind: classify(column) ?? "REAL", detail: jsonPaths(a, b).join("; ") });
    } else if (TIMESTAMP_COLUMNS.has(column)) {
      const outcome = compareTimestamp(supabase[column] as string | null, copy[column] as string | null);
      if (outcome === "equal") continue;
      equal = false;
      report.add({
        table,
        column,
        row,
        context,
        kind: outcome === "submillisecond" ? "submillisecond" : (classify(column) ?? "REAL"),
        detail: timestampDelta(supabase[column] as string | null, copy[column] as string | null),
      });
    } else {
      const a = supabase[column] ?? null;
      const b = copy[column] ?? null;
      if (a === b) continue;
      equal = false;
      const detail = SAFE_VALUE_COLUMNS.has(column) || typeof a === "number"
        ? `supabase ${String(a)}, copy ${String(b)}`
        : `supabase ${shape(a)}, copy ${shape(b)}`;
      report.add({ table, column, row, context, kind: classify(column) ?? "REAL", detail });
    }
  }
  bump(report.compared, table);
  if (equal) bump(report.equalRows, table);
  return equal;
}

async function compare() {
  const state = readState(need("state"));
  const report = new Report();
  const preimageMessages = new Set(state.preimage.messages.map((m) => m.id as string));
  const preimageConversations = new Set(state.preimage.conversations.map((c) => c.id as string));
  const preimageContacts = new Set(state.preimage.contacts.map((c) => c.id as string));
  const snapshot = new Date(state.since).getTime();

  await withSupabase(async (query) => {
    const events = await listEvents(query, state.since, state.until);
    const keys: Keys = { messages: new Set(), phones: new Set() };
    const processedAtMillis = new Set<string>();

    // webhook_events, and the keys the window really has.
    const copyEvents = new Map<string, Row>();
    for (const part of inChunks(events, 200)) {
      const rows = await execute(sql`SELECT ycloud_event_id, event_type, payload AS payload__text, processed_at FROM chatbase.webhook_events
                                     WHERE ycloud_event_id IN ${textList(part.map((e) => e.eventId))}`);
      for (const r of rows) copyEvents.set(r.ycloud_event_id as string, r);
    }
    for await (const event of withPayloads(query, events)) {
      addKeys(keys, event.payload);
      processedAtMillis.add(toMillis(event.processedAt) as string);
      const row = handle(event.id);
      const copy = copyEvents.get(event.eventId);
      bump(report.compared, "webhook_events");
      if (!copy) {
        report.add({ table: "webhook_events", column: "row", row, kind: "REAL", context: event.eventType, detail: "missing in copy" });
        continue;
      }
      let equal = true;
      if (copy.event_type !== event.eventType) {
        equal = false;
        report.add({ table: "webhook_events", column: "event_type", row, kind: "REAL" });
      }
      const copyPayload = JSON.parse(copy.payload__text as string);
      if (!isDeepStrictEqual(event.payload, copyPayload)) {
        equal = false;
        report.add({ table: "webhook_events", column: "payload", row, kind: "REAL", detail: jsonPaths(event.payload, copyPayload).join("; ") });
      }
      if (compareTimestamp(event.processedAt, copy.processed_at as string) === "different") {
        equal = false;
        report.add({ table: "webhook_events", column: "processed_at", row, kind: "REAL", detail: timestampDelta(event.processedAt, copy.processed_at as string) });
      }
      if (equal) bump(report.equalRows, "webhook_events");
    }

    // Anything newer than the window may have moved these rows in Supabase: they are left out.
    const newer: Keys = { messages: new Set(), phones: new Set() };
    const newerEvents = await listEvents(query, state.until, null);
    for await (const event of withPayloads(query, newerEvents)) addKeys(newer, event.payload);
    report.excluded.newerEvents = newerEvents.length;

    const messageKeys = [...keys.messages];
    const phones = [...keys.phones];

    // Contacts.
    const companies = (await execute(raw("SELECT DISTINCT company_id FROM chatbase.inboxes WHERE company_id IS NOT NULL"))).map((r) => r.company_id as string);
    const sbContacts = await query(`select ${pgColumns(CONTACT_COLUMNS)} from public.contacts where company_id = any($1::uuid[]) and phone_number = any($2::text[])`, [companies, phones]);
    const cpContacts = await copyContacts(phones);
    const contactKey = (r: Row) => `${r.company_id}|${r.phone_number}`;
    const cpContactByKey = new Map(cpContacts.map((r) => [contactKey(r), r]));
    const sbContactKeys = new Set(sbContacts.map(contactKey));
    const contactColumns = ["company_id", "phone_number", "name", "metadata", "created_at", "updated_at"];
    const contactNew = (r: Row) => !preimageContacts.has(r.id as string);
    for (const supabase of sbContacts) {
      if (newer.phones.has(supabase.phone_number as string)) {
        bump(report.excluded, "contacts_newer");
        continue;
      }
      const copy = cpContactByKey.get(contactKey(supabase));
      if (!copy) {
        report.add({ table: "contacts", column: "row", row: handle(supabase.id as string), kind: "REAL", detail: "missing in copy" });
        continue;
      }
      const isNew = contactNew(copy);
      const uiTouched = compareTimestamp(supabase.updated_at as string, copy.updated_at as string) === "different" &&
        new Date(toMillis(supabase.updated_at as string) as string) > new Date(copy.updated_at as string);
      const columns = isNew ? contactColumns : contactColumns;
      compareColumns(report, "contacts", columns, supabase, copy, (column) => {
        if (uiTouched) return "changed_outside_webhook";
        if (column === "created_at" && !isNew) return null;
        return null;
      }, isNew ? "created_in_window" : "existed");
    }
    for (const copy of cpContacts) {
      if (!sbContactKeys.has(contactKey(copy)) && contactNew(copy)) {
        report.add({ table: "contacts", column: "row", row: handle(copy.id as string), kind: "REAL", detail: "only in copy" });
      }
    }

    // Conversations, by inbox and contact: new rows have a different id on each side.
    const sbContactIds = sbContacts.map((c) => c.id as string);
    const sbContactById = new Map(sbContacts.map((c) => [c.id as string, c]));
    const cpContactById = new Map(cpContacts.map((c) => [c.id as string, c]));
    const sbConversations = await query(`select ${pgColumns(CONVERSATION_COLUMNS)} from public.conversations where contact_id = any($1::uuid[])`, [sbContactIds]);
    const cpConversations = await copyConversations(cpContacts.map((c) => c.id as string));
    const conversationKey = (r: Row, contacts: Map<string, Row>) => {
      const contact = contacts.get(r.contact_id as string);
      return `${r.inbox_id}|${contact ? contactKey(contact) : r.contact_id}`;
    };
    const cpConversationByKey = new Map(cpConversations.map((r) => [conversationKey(r, cpContactById), r]));

    // Messages.
    const sbMessages = await query(`select ${pgColumns(MESSAGE_COLUMNS)} from public.messages where ycloud_message_id = any($1::text[]) or wamid = any($1::text[])`, [messageKeys]);
    const cpMessages = await copyMessages(messageKeys);
    const cpMessageByYcloud = new Map(cpMessages.map((r) => [r.ycloud_message_id as string, r]));
    const cpMessageById = new Map(cpMessages.map((r) => [r.id as string, r]));
    const sbConversationById = new Map(sbConversations.map((c) => [c.id as string, c]));
    const cpConversationById = new Map(cpConversations.map((c) => [c.id as string, c]));
    const seenCopyMessages = new Set<string>();
    const enrichedPairs: Array<{ supabase: Row; copy: Row }> = [];
    const appSent = new Set<string>();
    const messageColumns = MESSAGE_COLUMNS.filter((c) => !["id", "conversation_id"].includes(c));
    for (const supabase of sbMessages) {
      const copy = cpMessageById.get(supabase.id as string) ?? cpMessageByYcloud.get(supabase.ycloud_message_id as string);
      if (copy) seenCopyMessages.add(copy.id as string);
      const key = [supabase.ycloud_message_id, supabase.wamid].filter(Boolean) as string[];
      if (key.some((k) => newer.messages.has(k))) {
        bump(report.excluded, "messages_newer");
        continue;
      }
      const inPreimage = copy ? preimageMessages.has(copy.id as string) : false;
      const createdAt = new Date(toMillis(supabase.created_at as string) as string).getTime();
      if (supabase.sent_by !== null && !inPreimage) {
        appSent.add(supabase.conversation_id as string);
        bump(report.excluded, "messages_app_sent_after_snapshot");
        continue;
      }
      if (!copy) {
        const kind = createdAt <= snapshot ? "outside_copy" : "REAL";
        report.add({ table: "messages", column: "row", row: handle(supabase.id as string), kind, context: `${String(supabase.direction)}/${String(supabase.type)}`, detail: "missing in copy" });
        continue;
      }
      if (!inPreimage && createdAt <= snapshot) {
        // An older message than the copy's cutoff: the copy never had its earlier state.
        bump(report.excluded, "messages_outside_copy");
        continue;
      }
      if (inPreimage && supabase.id !== copy.id) {
        report.add({ table: "messages", column: "id", row: handle(supabase.id as string), kind: "REAL" });
      }
      const sbConversation = sbConversationById.get(supabase.conversation_id as string);
      const cpConversation = cpConversationById.get(copy.conversation_id as string);
      if (sbConversation && cpConversation && conversationKey(sbConversation, sbContactById) !== conversationKey(cpConversation, cpContactById)) {
        report.add({ table: "messages", column: "conversation_id", row: handle(supabase.id as string), kind: "REAL" });
      }
      const enriched = isTextEnrichment(supabase, copy);
      if (enriched) enrichedPairs.push({ supabase, copy });
      compareColumns(report, "messages", messageColumns, supabase, copy, (column) => {
        if (enriched && (column === "body" || column === "template_name")) return "text_enrichment";
        return null;
      }, `${String(supabase.direction)}/${String(supabase.type)}/${inPreimage ? "existed" : "new"}/${supabase.sent_by ? "app" : "webhook"}`);
    }
    for (const copy of cpMessages) {
      if (seenCopyMessages.has(copy.id as string)) continue;
      report.add({ table: "messages", column: "row", row: handle(copy.id as string), kind: "REAL", context: `${String(copy.direction)}/${String(copy.type)}`, detail: "only in copy" });
    }

    // Conversations, now that app-sent messages are known.
    const sbConversationIds = sbConversations.map((c) => c.id as string);
    const appActive = await query(
      `select distinct conversation_id from public.messages where conversation_id = any($1::uuid[]) and created_at > $2::timestamptz and sent_by is not null`,
      [sbConversationIds, state.since],
    );
    for (const r of appActive) appSent.add(r.conversation_id as string);
    const conversationColumns = CONVERSATION_COLUMNS.filter((c) => !["id", "contact_id"].includes(c));
    const seenCopyConversations = new Set<string>();
    for (const supabase of sbConversations) {
      const key = conversationKey(supabase, sbContactById);
      const copy = cpConversationByKey.get(key);
      if (copy) seenCopyConversations.add(copy.id as string);
      const contact = sbContactById.get(supabase.contact_id as string);
      if (contact && newer.phones.has(contact.phone_number as string)) {
        bump(report.excluded, "conversations_newer");
        continue;
      }
      const inPreimage = copy ? preimageConversations.has(copy.id as string) : false;
      const createdAt = new Date(toMillis(supabase.created_at as string) as string).getTime();
      const outsideCopy = !inPreimage && createdAt <= snapshot;
      if (!copy) {
        if (createdAt <= snapshot) {
          bump(report.excluded, "conversations_outside_copy_untouched");
        } else {
          report.add({ table: "conversations", column: "row", row: handle(supabase.id as string), kind: "REAL", detail: "missing in copy" });
        }
        continue;
      }
      const preview = supabase.last_message_preview as string | null;
      const copyPreview = copy.last_message_preview as string | null;
      const enrichedPreview = enrichedPairs.some(
        ({ supabase: s, copy: c }) => s.conversation_id === supabase.id &&
          String(s.body).slice(0, 200) === preview && String(c.body).slice(0, 200) === copyPreview,
      );
      const updatedLater = new Date(toMillis(supabase.updated_at as string) as string).getTime() > new Date(copy.updated_at as string).getTime() + 1;
      const hasApp = appSent.has(supabase.id as string);
      compareColumns(report, "conversations", conversationColumns, supabase, copy, (column) => {
        if (outsideCopy) return "outside_copy";
        if (column === "unread_count" && (supabase.unread_count as number) < (copy.unread_count as number)) return "unread_reset_by_ui";
        if (column === "last_message_preview" && enrichedPreview) return "text_enrichment";
        if (hasApp && ["last_message_at", "last_message_preview", "updated_at"].includes(column)) return "app_sent_activity";
        if (updatedLater && ["status", "assignee_id", "updated_at", "unread_count"].includes(column)) return "changed_outside_webhook";
        return null;
      }, `${inPreimage ? "existed" : "new"}${hasApp ? "/app" : ""}${updatedLater ? "/later" : ""}`);
    }
    for (const copy of cpConversations) {
      if (!seenCopyConversations.has(copy.id as string)) {
        report.add({ table: "conversations", column: "row", row: handle(copy.id as string), kind: "REAL", detail: "only in copy" });
      }
    }

    // conversation_tags, by the conversation's natural key.
    const sbTags = await query(`select ${pgColumns(TAG_COLUMNS)} from public.conversation_tags where conversation_id = any($1::uuid[])`, [sbConversationIds]);
    const cpTags = await copyTags(cpConversations.map((c) => c.id as string));
    const tagsOf = (rows: Row[]) => {
      const byConversation = new Map<string, Map<string, Row>>();
      for (const row of rows) {
        const id = row.conversation_id as string;
        if (!byConversation.has(id)) byConversation.set(id, new Map());
        byConversation.get(id)?.set(row.tag_id as string, row);
      }
      return byConversation;
    };
    const sbTagMap = tagsOf(sbTags);
    const cpTagMap = tagsOf(cpTags);
    const pairs = sbConversations.flatMap((c) => {
      const copy = cpConversationByKey.get(conversationKey(c, sbContactById));
      return copy ? [{ supabase: c, copy }] : [];
    });
    for (const { supabase, copy } of pairs) {
      const contact = sbContactById.get(supabase.contact_id as string);
      if (contact && newer.phones.has(contact.phone_number as string)) continue;
      const a = sbTagMap.get(supabase.id as string) ?? new Map<string, Row>();
      const b = cpTagMap.get(copy.id as string) ?? new Map<string, Row>();
      const outsideCopy = !preimageConversations.has(copy.id as string) &&
        new Date(toMillis(supabase.created_at as string) as string).getTime() <= snapshot;
      bump(report.compared, "conversation_tags");
      let equal = true;
      for (const tag of new Set([...a.keys(), ...b.keys()])) {
        const sbTag = a.get(tag);
        const cpTag = b.get(tag);
        const row = handle(`${String(supabase.id)}|${tag}`);
        if (sbTag && cpTag) {
          const outcome = compareTimestamp(sbTag.created_at as string, cpTag.created_at as string);
          if (outcome === "different") {
            equal = false;
            report.add({ table: "conversation_tags", column: "created_at", row, kind: outsideCopy ? "outside_copy" : "REAL", detail: timestampDelta(sbTag.created_at as string, cpTag.created_at as string) });
          }
          continue;
        }
        equal = false;
        // The webhook stamps its tag with the event's now(); any other time was a person in the UI.
        const byEvent = sbTag ? processedAtMillis.has(toMillis(sbTag.created_at as string) as string) : false;
        const kind = outsideCopy ? "outside_copy" : sbTag && !byEvent ? "changed_outside_webhook" : !sbTag && a.size > 0 ? "changed_outside_webhook" : "REAL";
        report.add({ table: "conversation_tags", column: "tag_id", row, kind, detail: sbTag ? "only in supabase" : "only in copy" });
      }
      if (equal) bump(report.equalRows, "conversation_tags");
    }
  });

  const kinds = new Set((option("details") ?? "REAL").split(","));
  console.log(JSON.stringify(report.summary(kinds), null, 2));
}

// Live checks with synthetic rows --------------------------------------------

/** Numbers no real contact has. Rows are recognized by their prefix and removed afterwards. */
const TEST_PREFIX = "replay-check-";
const testPhone = (run: string, n = 0) => `+000${run}${n}`;

async function cleanTestRows(phones: string[]) {
  await execute(sql`DELETE FROM chatbase.messages WHERE ycloud_message_id LIKE ${`${TEST_PREFIX}%`}`);
  await execute(sql`DELETE FROM chatbase.conversations
                    WHERE contact_id IN (SELECT id FROM chatbase.contacts WHERE phone_number IN ${textList(phones)})`);
  await execute(sql`DELETE FROM chatbase.contacts WHERE phone_number IN ${textList(phones)}`);
  await execute(sql`DELETE FROM chatbase.webhook_events WHERE ycloud_event_id LIKE ${`${TEST_PREFIX}%`}`);
}

async function testInbox() {
  const [inbox] = await execute(raw("SELECT TOP (1) id, phone_number, company_id FROM chatbase.inboxes WHERE company_id IS NOT NULL ORDER BY created_at, id"));
  return inbox;
}

const shuffled = <T>(items: T[]) =>
  items.map((item) => ({ item, key: Math.random() })).sort((a, b) => a.key - b.key).map(({ item }) => item);

/** Like runEvent in webhook.ts, but the work function sees each attempt, so retries can be counted. */
async function observedEvent(db: SqlDb, id: string, type: string, payload: unknown, tally: Record<string, number>) {
  try {
    return await inTransaction(db, async (tx) => {
      bump(tally, "attempts");
      try {
        return await applyYCloudEvent(tx, id, type, payload);
      } catch (err) {
        if (!(err instanceof DuplicateEvent)) bump(tally, `attempt_failed_${errorKind(err)}`);
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof DuplicateEvent) return { ok: true, duplicate: true };
    throw err;
  }
}

const INBOUND = "whatsapp.inbound_message.received";
const UPDATED = "whatsapp.message.updated";

async function concurrency() {
  confirmDatabase();
  const db = systemSqlDb();
  const run = String(Date.now()).slice(-8);
  const phone = testPhone(run);
  const inbox = await testInbox();
  const prefix = `${TEST_PREFIX}${run}-`;
  const report: Record<string, unknown> = {};
  const at = () => new Date().toISOString();
  const inbound = (n: string) => ({
    id: `${prefix}ev-in-${n}`,
    type: INBOUND,
    payload: { whatsappInboundMessage: { id: `${prefix}${n.startsWith("a") ? "in-" : "z"}${n}i`, from: phone, to: inbox.phone_number, type: "text", text: { body: "check" }, createTime: at() } },
  });
  const outbound = (n: string) => ({
    id: `${prefix}ev-out-${n}`,
    type: UPDATED,
    // Beside the inbound ids of the same round: new ids in one index gap are the hard case.
    payload: { whatsappMessage: { id: `${prefix}z${n}o`, from: inbox.phone_number, to: phone, type: "text", status: "sent", text: { body: "check" }, createTime: at() } },
  });
  const status = (target: string, n: string) => ({
    id: `${prefix}ev-st-${n}`,
    type: UPDATED,
    payload: { whatsappMessage: { id: target, from: inbox.phone_number, to: phone, type: "text", status: "read", text: { body: "check" }, createTime: at() } },
  });
  const reaction = (target: string, n: string) => ({
    id: `${prefix}ev-re-${n}`,
    type: INBOUND,
    payload: { whatsappInboundMessage: { id: `${prefix}re-${n}`, from: phone, to: inbox.phone_number, type: "reaction", reaction: { message_id: target, emoji: "+" } } },
  });
  type Item = { id: string; type: string; payload: unknown };
  const fire = async (name: string, items: Item[]) => {
    const tally: Record<string, number> = {};
    const times: number[] = [];
    const started = performance.now();
    await Promise.all(items.map(async (item) => {
      const t0 = performance.now();
      try {
        const result = await observedEvent(db, item.id, item.type, item.payload, tally);
        bump(tally, `result_${resultKind(result as Record<string, unknown>)}`);
      } catch (err) {
        bump(tally, `error_${errorKind(err)}`);
      }
      times.push(Math.round(performance.now() - t0));
    }));
    report[name] = { events: items.length, wallMs: Math.round(performance.now() - started), perEventMs: timings(times), tally };
  };
  try {
    await fire("new_contact_race", Array.from({ length: 8 }, (_, i) => inbound(`a${i}`)));
    for (let round = 0; round < 3; round++) {
      await fire(`mixed_round_${round}`, shuffled<Item>([
        ...Array.from({ length: 5 }, (_, i) => inbound(`b${round}x${i}`)),
        ...Array.from({ length: 5 }, (_, i) => outbound(`b${round}x${i}`)),
        ...Array.from({ length: 3 }, (_, i) => status(`${prefix}in-a${i}i`, `b${round}x${i}`)),
        ...Array.from({ length: 3 }, (_, i) => reaction(`${prefix}in-a${i}i`, `b${round}x${i}`)),
      ]));
    }
    const same = inbound("same");
    await fire("same_event_five_times", Array.from({ length: 5 }, () => same));

    const [conversation] = await execute(sql`SELECT c.unread_count, c.id FROM chatbase.conversations c
                                             JOIN chatbase.contacts k ON k.id = c.contact_id
                                             WHERE k.phone_number = ${phone}`);
    const [counts] = await execute(sql`SELECT
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
      SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
      FROM chatbase.messages WHERE conversation_id = ${conversation.id as string}`);
    const [contacts] = await execute(sql`SELECT COUNT(*) AS n FROM chatbase.contacts WHERE phone_number = ${phone}`);
    report.consistency = {
      contacts: contacts.n,
      unreadExpected: 8 + 15 + 1,
      unread: conversation.unread_count,
      inboundExpected: 24,
      inbound: counts.inbound,
      outboundExpected: 15,
      outbound: counts.outbound,
    };
  } finally {
    await cleanTestRows([phone]);
  }
  console.log(JSON.stringify(report, null, 2));
}

/** A failure after the contact upsert, and one the server raises: nothing of either may remain. */
async function rollbackCheck() {
  confirmDatabase();
  const db = systemSqlDb();
  const run = String(Date.now()).slice(-8);
  const phoneA = testPhone(run, 1);
  const phoneB = testPhone(run, 2);
  const inbox = await testInbox();
  const prefix = `${TEST_PREFIX}${run}-`;
  const remains = async (eventId: string, phone: string) => {
    const [row] = await execute(sql`SELECT
      (SELECT COUNT(*) FROM chatbase.webhook_events WHERE ycloud_event_id = ${eventId}) AS events,
      (SELECT COUNT(*) FROM chatbase.contacts WHERE phone_number = ${phone}) AS contacts,
      (SELECT COUNT(*) FROM chatbase.conversations c JOIN chatbase.contacts k ON k.id = c.contact_id WHERE k.phone_number = ${phone}) AS conversations`);
    return row;
  };
  const report: Record<string, unknown> = {};
  try {
    const parseFail = { whatsappInboundMessage: { id: `${prefix}a`, from: phoneA, to: inbox.phone_number, type: "text", text: { body: "check" }, createTime: "not a time" } };
    report.app_error = await processYCloudEvent(db, `${prefix}ev-a`, INBOUND, parseFail).then(() => "no error", errorKind);
    report.app_error_remains = await remains(`${prefix}ev-a`, phoneA);

    const tooLong = { whatsappInboundMessage: { id: `${prefix}${"x".repeat(200)}`, from: phoneB, to: inbox.phone_number, type: "text", text: { body: "check" } } };
    report.server_error = await processYCloudEvent(db, `${prefix}ev-b`, INBOUND, tooLong).then(() => "no error", errorKind);
    report.server_error_remains = await remains(`${prefix}ev-b`, phoneB);

    const fixed = { whatsappInboundMessage: { id: `${prefix}c`, from: phoneA, to: inbox.phone_number, type: "text", text: { body: "check" } } };
    report.same_id_after_failure = resultKind(await processYCloudEvent(db, `${prefix}ev-a`, INBOUND, fixed));
    report.same_id_again = resultKind(await processYCloudEvent(db, `${prefix}ev-a`, INBOUND, fixed));
    report.xact = await inTransaction(db, (tx) =>
      tx.run(raw("SELECT @@TRANCOUNT AS trancount, CASE WHEN @@OPTIONS & 16384 = 16384 THEN 1 ELSE 0 END AS xact_abort, @@LOCK_TIMEOUT AS lock_timeout")),
    );
  } finally {
    await cleanTestRows([phoneA, phoneB]);
  }
  console.log(JSON.stringify(report, null, 2));
}

const commands: Record<string, () => Promise<void>> = { prepare, replay, compare, reset, concurrency, rollback: rollbackCheck };
if (!commands[command]) {
  console.error(`Commands: ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
commands[command]().then(
  () => process.exit(0),
  (err) => {
    // SQL Server's messages quote key values, so only the kind leaves this process.
    console.error(`Failed: ${errorKind(err)}`);
    process.exit(1);
  },
);
