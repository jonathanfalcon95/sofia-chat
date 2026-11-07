import { EventEmitter } from "node:events";
import { execute, type Row } from "@/lib/db/sqlserver/connection";
import { raw, sql } from "@/lib/db/sqlserver/sql";
import { pushToRing, type RealtimeEvent } from "./events";

const TICK_MS = 2_000;
/** Nobody polling for this long stops the database queries. */
const IDLE_STOP_MS = 90_000;
const BATCH = 200;
/** A row first seen this recently counts as new rather than as an update. */
const NEW_WINDOW_MS = 10 * 60_000;
const SEEN_LIMIT = 5_000;

type State = {
  epoch: string;
  seq: number;
  ring: RealtimeEvent[];
  bus: EventEmitter;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  lastDemand: number;
  messageCursor: string | null;
  conversationCursor: string | null;
  seen: Set<string>;
};

const holder = globalThis as unknown as { __chatbaseRealtime?: State };

function state(): State {
  holder.__chatbaseRealtime ??= {
    epoch: new Date().toISOString(),
    seq: 0,
    ring: [],
    bus: new EventEmitter().setMaxListeners(0),
    timer: null,
    ticking: false,
    lastDemand: 0,
    messageCursor: null,
    conversationCursor: null,
    seen: new Set(),
  };
  return holder.__chatbaseRealtime;
}

function isNew(s: State, key: string, createdAt: unknown) {
  const firstSeen = !s.seen.has(key);
  s.seen.add(key);
  if (s.seen.size > SEEN_LIMIT) s.seen.delete(s.seen.values().next().value as string);
  return firstSeen && Date.now() - new Date(String(createdAt)).getTime() < NEW_WINDOW_MS;
}

async function latestVersion(table: "messages" | "conversations") {
  const [row] = await execute(
    sql`SELECT CAST(MAX(change_version) AS bigint) AS version FROM ${raw(`chatbase.${table}`)}`,
  );
  return String(row?.version ?? 0);
}

/** MIN_ACTIVE_ROWVERSION keeps an open transaction's rows from being skipped once it commits. */
async function readMessages(cursor: string): Promise<Row[]> {
  return execute(sql`
    SELECT TOP (${BATCH}) CAST(m.change_version AS bigint) AS version,
      m.id, m.conversation_id, m.company_id, m.direction, m.type, m.body, m.status, m.created_at,
      m.template_name, m.media_url, m.media_mime, m.media_filename, m.ycloud_message_id, m.wamid,
      m.reply_to_wamid, m.reactions, m.rich_content, c.inbox_id
    FROM chatbase.messages m
    JOIN chatbase.conversations c ON c.id = m.conversation_id
    WHERE m.change_version > CAST(CAST(${cursor} AS bigint) AS binary(8))
      AND m.change_version < MIN_ACTIVE_ROWVERSION()
    ORDER BY m.change_version`);
}

async function readConversations(cursor: string): Promise<Row[]> {
  return execute(sql`
    SELECT TOP (${BATCH}) CAST(change_version AS bigint) AS version,
      id, company_id, inbox_id, contact_id, status, assignee_id, last_message_at, last_inbound_at,
      window_expires_at, last_message_preview, unread_count, created_at, updated_at
    FROM chatbase.conversations
    WHERE change_version > CAST(CAST(${cursor} AS bigint) AS binary(8))
      AND change_version < MIN_ACTIVE_ROWVERSION()
    ORDER BY change_version`);
}

function publish(s: State, table: RealtimeEvent["table"], rows: Row[]) {
  for (const { version: _version, ...row } of rows) {
    pushToRing(s.ring, {
      seq: ++s.seq,
      table,
      eventType: isNew(s, `${table}:${row.id}`, row.created_at) ? "INSERT" : "UPDATE",
      companyId: (row.company_id as string | null) ?? null,
      inboxId: (row.inbox_id as string | null) ?? null,
      row: row as RealtimeEvent["row"],
    });
  }
}

async function tick() {
  const s = state();
  if (s.ticking) return;
  s.ticking = true;
  try {
    s.messageCursor ??= await latestVersion("messages");
    s.conversationCursor ??= await latestVersion("conversations");

    const [messages, conversations] = await Promise.all([
      readMessages(s.messageCursor),
      readConversations(s.conversationCursor),
    ]);
    if (messages.length) {
      s.messageCursor = String(messages[messages.length - 1].version);
      publish(s, "messages", messages);
    }
    if (conversations.length) {
      s.conversationCursor = String(conversations[conversations.length - 1].version);
      publish(s, "conversations", conversations);
    }
    if (messages.length || conversations.length) s.bus.emit("change");
  } catch (err) {
    console.error("[realtime] tick failed", err);
  } finally {
    s.ticking = false;
    if (Date.now() - s.lastDemand > IDLE_STOP_MS && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
      // Whatever changed while idle is covered by the client reload on reconnect.
      s.messageCursor = null;
      s.conversationCursor = null;
    }
  }
}

/** Marks that someone is listening and starts reading changes if nothing is. */
export function touchRealtime() {
  const s = state();
  s.lastDemand = Date.now();
  if (!s.timer) {
    s.timer = setInterval(() => void tick(), TICK_MS);
    s.timer.unref();
    void tick();
  }
  return s;
}

/** Resolves on the next batch of changes, or after `ms`. */
export function waitForChange(ms: number, signal: AbortSignal) {
  const s = state();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      s.bus.off("change", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    s.bus.on("change", finish);
    signal.addEventListener("abort", finish);
  });
}
