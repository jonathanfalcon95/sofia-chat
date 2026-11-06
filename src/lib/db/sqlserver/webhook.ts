import {
  applyReaction,
  applySendTime,
  assertJsonbStorable,
  inboundTimestamp,
  matchInbox,
  mergeInboundContact,
  mergeInboundConversation,
  mergeInboundMessage,
  mergeOutboundConversation,
  mergeOutboundMessage,
  newInboundConversation,
  planInboundMessage,
  planOutboundMessage,
  remapEventType,
  REVOKED_BODY,
  revokedRawPayload,
  routeEvent,
  type Envelope,
  type InboxRow,
  type MessageContent,
  type MessagePatch,
  type PlannedContact,
  type StoredMessage,
} from "../../ycloud/event-parser.ts";
import type { Row } from "./connection.ts";
import { failure, inTransaction, type SqlDb, type SqlResult } from "./db.ts";
import { isUuid, raw, sql, type SqlFragment } from "./sql.ts";

/**
 * Port of the Postgres functions process_ycloud_event, process_ycloud_webhook and
 * process_ycloud_webhook_for_account. Decisions live in ycloud/event-parser.ts; this file runs the
 * statements, in one transaction like the single plpgsql call.
 */

export type EventOptions = { now?: Date };

type EventResult = Record<string, unknown>;

/** `now()` for values the replay compares, and the updated_at the trigger used to set. */
type Clock = { now: Date; iso: string; updatedAt: SqlFragment };

function clockOf(options?: EventOptions): Clock {
  const now = options?.now ?? new Date();
  const iso = now.toISOString();
  return {
    now,
    iso,
    updatedAt: options?.now ? sql`CAST(${iso} AS datetime2(3))` : raw("SYSUTCDATETIME()"),
  };
}

/** The event was already processed. */
export class DuplicateEvent extends Error {
  constructor() {
    super("duplicate webhook event");
    this.name = "DuplicateEvent";
  }
}

function isUniqueViolation(err: unknown) {
  const number = (err as { number?: number } | null)?.number;
  return number === 2627 || number === 2601;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

async function recordEvent(
  tx: SqlDb,
  eventId: string,
  eventType: string,
  payload: unknown,
  clock: Clock,
) {
  try {
    await tx.run(sql`INSERT INTO chatbase.webhook_events (ycloud_event_id, event_type, payload, processed_at)
                     VALUES (${eventId}, ${eventType}, ${json(payload)}, ${clock.iso})`);
  } catch (err) {
    throw isUniqueViolation(err) ? new DuplicateEvent() : err;
  }
}

async function listInboxes(tx: SqlDb): Promise<InboxRow[]> {
  // Few rows, and matching ignores formatting. `limit 1` had no order; this one is at least stable.
  const rows = await tx.run(sql`SELECT id, company_id, phone_number FROM chatbase.inboxes
                                ORDER BY created_at, id`);
  return rows as InboxRow[];
}

async function findTargetMessage(tx: SqlDb, companyId: string, target: string) {
  const [row] = await tx.run(sql`SELECT TOP (1) id, reactions FROM chatbase.messages WITH (UPDLOCK)
                                 WHERE company_id = ${companyId}
                                   AND (wamid = ${target} OR ycloud_message_id = ${target})
                                 ORDER BY created_at DESC`);
  return row;
}

async function saveReaction(
  tx: SqlDb,
  message: Row,
  reaction: Parameters<typeof applyReaction>[1],
) {
  await tx.run(sql`UPDATE chatbase.messages
                   SET reactions = ${json(applyReaction(message.reactions, reaction))}
                   WHERE id = ${message.id as string}`);
}

async function upsertInboundContact(
  tx: SqlDb,
  companyId: string,
  planned: PlannedContact,
  clock: Clock,
): Promise<string> {
  const [existing] = await tx.run(sql`SELECT id, name, phone_number, metadata
                                      FROM chatbase.contacts WITH (UPDLOCK, HOLDLOCK)
                                      WHERE company_id = ${companyId} AND phone_number = ${planned.phone}`);
  if (existing) {
    const merged = mergeInboundContact(
      {
        name: existing.name as string | null,
        phone_number: existing.phone_number as string,
        metadata: existing.metadata,
      },
      planned,
    );
    await tx.run(sql`UPDATE chatbase.contacts
                     SET name = ${merged.name}, metadata = ${json(merged.metadata)}, updated_at = ${clock.updatedAt}
                     WHERE id = ${existing.id as string}`);
    return existing.id as string;
  }
  const [inserted] = await tx.run(sql`INSERT INTO chatbase.contacts (company_id, phone_number, name, metadata, created_at, updated_at)
                                      OUTPUT INSERTED.id
                                      VALUES (${companyId}, ${planned.phone}, ${planned.name}, ${json(planned.metadata)}, ${clock.iso}, ${clock.iso})`);
  return inserted.id as string;
}

/** The SQL caught unique_violation and went on; T-SQL has no savepoint for that, so check first. */
async function changeContactPhone(
  tx: SqlDb,
  companyId: string,
  from: string,
  newPhone: string,
  clock: Clock,
) {
  if (newPhone !== from) {
    const clash = await tx.run(sql`SELECT TOP (1) id FROM chatbase.contacts WITH (UPDLOCK, HOLDLOCK)
                                   WHERE company_id = ${companyId} AND phone_number = ${newPhone}`);
    if (clash.length > 0) return;
  }
  await tx.run(sql`UPDATE chatbase.contacts
                   SET phone_number = ${newPhone}, updated_at = ${clock.updatedAt}
                   WHERE company_id = ${companyId} AND phone_number = ${from}`);
}

async function upsertInboundConversation(
  tx: SqlDb,
  companyId: string,
  inboxId: string,
  contactId: string,
  at: Date,
  preview: string,
  clock: Clock,
): Promise<string> {
  const [existing] = await tx.run(sql`SELECT id, status, unread_count
                                      FROM chatbase.conversations WITH (UPDLOCK, HOLDLOCK)
                                      WHERE inbox_id = ${inboxId} AND contact_id = ${contactId}`);
  if (existing) {
    const merged = mergeInboundConversation(
      { status: existing.status as string, unread_count: existing.unread_count as number },
      at,
      preview,
    );
    await tx.run(sql`UPDATE chatbase.conversations
                     SET last_message_at = ${merged.lastMessageAt},
                         last_inbound_at = ${merged.lastInboundAt},
                         window_expires_at = ${merged.windowExpiresAt},
                         last_message_preview = ${merged.preview},
                         unread_count = ${merged.unreadCount},
                         status = ${merged.status},
                         updated_at = ${clock.updatedAt}
                     WHERE id = ${existing.id as string}`);
    return existing.id as string;
  }
  const row = newInboundConversation(at, preview);
  const [inserted] = await tx.run(sql`INSERT INTO chatbase.conversations
                                        (company_id, inbox_id, contact_id, status, last_message_at, last_inbound_at,
                                         window_expires_at, last_message_preview, unread_count, created_at, updated_at)
                                      OUTPUT INSERTED.id
                                      VALUES (${companyId}, ${inboxId}, ${contactId}, ${row.status}, ${row.lastMessageAt},
                                              ${row.lastInboundAt}, ${row.windowExpiresAt}, ${row.preview}, ${row.unreadCount},
                                              ${clock.iso}, ${clock.iso})`);
  return inserted.id as string;
}

const MESSAGE_COLUMNS = raw(
  "id, body, wamid, reply_to_wamid, media_url, media_mime, media_filename, media_sha256, raw_payload",
);

function storedMessage(row: Row): StoredMessage {
  return {
    body: row.body as string | null,
    wamid: row.wamid as string | null,
    reply_to_wamid: row.reply_to_wamid as string | null,
    media_url: row.media_url as string | null,
    media_mime: row.media_mime as string | null,
    media_filename: row.media_filename as string | null,
    media_sha256: row.media_sha256 as string | null,
    raw_payload: row.raw_payload ?? undefined,
  };
}

function patchAssignments(patch: MessagePatch): SqlFragment {
  return sql`status = ${patch.status},
             raw_payload = ${json(patch.rawPayload)},
             wamid = ${patch.wamid},
             reply_to_wamid = ${patch.replyTo},
             media_url = ${patch.mediaUrl},
             media_mime = ${patch.mediaMime},
             media_filename = ${patch.mediaFilename},
             media_sha256 = ${patch.mediaSha256},
             body = ${patch.body}`;
}

async function upsertInboundMessage(
  tx: SqlDb,
  companyId: string,
  conversationId: string,
  envelope: Envelope,
  content: MessageContent,
  clock: Clock,
) {
  // A NULL id never conflicts: `on conflict` does not match NULLs, and neither does this.
  const [existing] =
    envelope.msgId === null
      ? []
      : await tx.run(sql`SELECT ${MESSAGE_COLUMNS} FROM chatbase.messages WITH (UPDLOCK, HOLDLOCK)
                         WHERE ycloud_message_id = ${envelope.msgId}`);
  if (existing) {
    const patch = mergeInboundMessage(storedMessage(existing), envelope, content);
    await tx.run(sql`UPDATE chatbase.messages
                     SET ${patchAssignments(patch)}, type = ${content.type}
                     WHERE id = ${existing.id as string}`);
    return;
  }
  await insertMessage(tx, companyId, conversationId, "inbound", envelope, content, clock.iso);
}

async function insertMessage(
  tx: SqlDb,
  companyId: string,
  conversationId: string,
  direction: "inbound" | "outbound",
  envelope: Envelope,
  content: MessageContent,
  createdAt: string,
) {
  await tx.run(sql`INSERT INTO chatbase.messages
                     (conversation_id, company_id, direction, type, body, ycloud_message_id, wamid, reply_to_wamid,
                      status, raw_payload, media_url, media_mime, media_filename, media_sha256, created_at)
                   VALUES (${conversationId}, ${companyId}, ${direction}, ${content.type}, ${content.body},
                           ${envelope.msgId}, ${envelope.wamid}, ${envelope.replyTo}, ${envelope.status},
                           ${json(envelope.msg)}, ${content.mediaUrl}, ${content.mediaMime},
                           ${content.mediaFilename}, ${content.mediaSha256}, ${createdAt})`);
}

/** The first kanban column by position, unless the conversation is already in one. */
async function assignFirstKanbanTag(
  tx: SqlDb,
  companyId: string,
  conversationId: string,
  clock: Clock,
) {
  await tx.run(sql`INSERT INTO chatbase.conversation_tags (conversation_id, tag_id, created_at)
                   SELECT TOP (1) CAST(${conversationId} AS uniqueidentifier), t.id, CAST(${clock.iso} AS datetime2(3))
                   FROM chatbase.tags t
                   WHERE t.company_id = ${companyId}
                     AND t.is_kanban_column = 1
                     AND NOT EXISTS (
                       SELECT 1
                       FROM chatbase.conversation_tags ct WITH (UPDLOCK, HOLDLOCK)
                       JOIN chatbase.tags k ON k.id = ct.tag_id
                       WHERE ct.conversation_id = ${conversationId} AND k.is_kanban_column = 1
                     )
                   ORDER BY t.position, t.created_at`);
}

async function applyInbound(tx: SqlDb, envelope: Envelope, clock: Clock): Promise<EventResult> {
  const inbox = matchInbox(await listInboxes(tx), envelope.to);
  if (!inbox) return { ok: true, skipped: "inbox_not_found" };
  const companyId = inbox.company_id;
  if (companyId === null) return { ok: true, skipped: "inbox_unassigned" };

  const plan = planInboundMessage(envelope);

  if (plan.kind === "reaction") {
    if (plan.target === null) return { ok: true, skipped: "reaction_missing_target" };
    const message = await findTargetMessage(tx, companyId, plan.target);
    if (!message) return { ok: true, skipped: "reaction_target_not_found" };
    await saveReaction(tx, message, {
      emoji: plan.emoji,
      from: envelope.from,
      direction: "inbound",
    });
    return { ok: true, reaction: true, message_id: message.id };
  }

  if (plan.kind === "revoke") {
    if (plan.target !== null) {
      const matches = await tx.run(sql`SELECT id, raw_payload FROM chatbase.messages WITH (UPDLOCK)
                                       WHERE company_id = ${companyId}
                                         AND (wamid = ${plan.target} OR ycloud_message_id = ${plan.target})`);
      for (const match of matches) {
        const merged = revokedRawPayload(match.raw_payload ?? undefined, envelope.msg, clock.now);
        await tx.run(sql`UPDATE chatbase.messages
                         SET body = ${REVOKED_BODY}, media_url = NULL, media_mime = NULL,
                             media_filename = NULL, media_sha256 = NULL, raw_payload = ${json(merged)}
                         WHERE id = ${match.id as string}`);
      }
    }
    return { ok: true, revoked: plan.target };
  }

  const contactId = await upsertInboundContact(tx, companyId, plan.contact, clock);
  if (plan.newPhone !== null) {
    await changeContactPhone(tx, companyId, envelope.from, plan.newPhone, clock);
  }

  const at = inboundTimestamp(envelope.msg, clock.now);
  const conversationId = await upsertInboundConversation(
    tx,
    companyId,
    inbox.id,
    contactId,
    at,
    plan.preview,
    clock,
  );
  await upsertInboundMessage(tx, companyId, conversationId, envelope, plan.content, clock);
  await assignFirstKanbanTag(tx, companyId, conversationId, clock);
  return { ok: true, conversation_id: conversationId };
}

async function upsertOutboundContact(
  tx: SqlDb,
  companyId: string,
  phone: string,
  clock: Clock,
): Promise<string> {
  const [existing] = await tx.run(sql`SELECT id FROM chatbase.contacts WITH (UPDLOCK, HOLDLOCK)
                                      WHERE company_id = ${companyId} AND phone_number = ${phone}`);
  if (existing) {
    await tx.run(sql`UPDATE chatbase.contacts SET updated_at = ${clock.updatedAt}
                     WHERE id = ${existing.id as string}`);
    return existing.id as string;
  }
  const [inserted] = await tx.run(sql`INSERT INTO chatbase.contacts (company_id, phone_number, created_at, updated_at)
                                      OUTPUT INSERTED.id
                                      VALUES (${companyId}, ${phone}, ${clock.iso}, ${clock.iso})`);
  return inserted.id as string;
}

async function upsertOutboundConversation(
  tx: SqlDb,
  companyId: string,
  inboxId: string,
  contactId: string,
  at: Date,
  preview: string,
  clock: Clock,
): Promise<string> {
  const [existing] = await tx.run(sql`SELECT id, last_message_at
                                      FROM chatbase.conversations WITH (UPDLOCK, HOLDLOCK)
                                      WHERE inbox_id = ${inboxId} AND contact_id = ${contactId}`);
  if (existing) {
    const merged = mergeOutboundConversation(
      { last_message_at: existing.last_message_at as string | null },
      at,
      preview,
    );
    await tx.run(sql`UPDATE chatbase.conversations
                     SET last_message_at = ${merged.lastMessageAt},
                         last_message_preview = ${merged.preview},
                         updated_at = ${clock.updatedAt}
                     WHERE id = ${existing.id as string}`);
    return existing.id as string;
  }
  const atIso = at.toISOString();
  const [inserted] = await tx.run(sql`INSERT INTO chatbase.conversations
                                        (company_id, inbox_id, contact_id, last_message_at, last_message_preview, created_at, updated_at)
                                      OUTPUT INSERTED.id
                                      VALUES (${companyId}, ${inboxId}, ${contactId}, ${atIso}, ${preview}, ${clock.iso}, ${clock.iso})`);
  return inserted.id as string;
}

async function applyOutbound(tx: SqlDb, envelope: Envelope, clock: Clock): Promise<EventResult> {
  const plan = planOutboundMessage(envelope);

  if (plan.kind === "reaction") {
    const inbox = matchInbox(await listInboxes(tx), envelope.from);
    if (!inbox) return { ok: true, skipped: "reaction_inbox_not_found" };
    const companyId = inbox.company_id;
    if (companyId === null) return { ok: true, skipped: "inbox_unassigned" };
    if (plan.target === null) return { ok: true, skipped: "reaction_missing_target" };
    const message = await findTargetMessage(tx, companyId, plan.target);
    if (!message) return { ok: true, skipped: "reaction_target_not_found" };
    await saveReaction(tx, message, {
      emoji: plan.emoji,
      from: envelope.from,
      direction: "outbound",
    });
    return {
      ok: true,
      reaction: true,
      direction: "outbound",
      message_id: message.id,
    };
  }

  // No HOLDLOCK yet: a range lock on the message index taken before the contact's would invert the
  // inbound order (contact, conversation, message) and deadlock on a conversation with both going on.
  const matches = await tx.run(sql`SELECT ${MESSAGE_COLUMNS} FROM chatbase.messages WITH (UPDLOCK)
                                   WHERE ycloud_message_id = ${envelope.msgId} OR wamid = ${envelope.wamid}`);
  if (matches.length > 0) {
    for (const match of matches) {
      const patch = mergeOutboundMessage(storedMessage(match), envelope, plan.content);
      await tx.run(sql`UPDATE chatbase.messages SET ${patchAssignments(patch)}
                       WHERE id = ${match.id as string}`);
    }
    return { ok: true, updated: true, wamid: envelope.wamid };
  }

  const inbox = matchInbox(await listInboxes(tx), envelope.from);
  if (!inbox) return { ok: true, skipped: "inbox_not_found" };
  const companyId = inbox.company_id;
  if (companyId === null) return { ok: true, skipped: "inbox_unassigned" };

  const contactId = await upsertOutboundContact(tx, companyId, envelope.to, clock);
  const at = inboundTimestamp(envelope.msg, clock.now);
  const conversationId = await upsertOutboundConversation(
    tx,
    companyId,
    inbox.id,
    contactId,
    at,
    plan.preview,
    clock,
  );
  // The insert's `on conflict`: a concurrent call for the same id got here first.
  const [conflict] =
    envelope.msgId === null
      ? []
      : await tx.run(sql`SELECT ${MESSAGE_COLUMNS} FROM chatbase.messages WITH (UPDLOCK, HOLDLOCK)
                         WHERE ycloud_message_id = ${envelope.msgId}`);
  if (conflict) {
    const patch = mergeOutboundMessage(storedMessage(conflict), envelope, plan.content);
    await tx.run(sql`UPDATE chatbase.messages SET ${patchAssignments(patch)}
                     WHERE id = ${conflict.id as string}`);
    return { ok: true, conversation_id: conversationId };
  }
  // sent_by is NULL here, so the trigger messages_apply_send_time decides over the column default.
  const createdAt = applySendTime(envelope.msg) ?? clock.now;
  await insertMessage(
    tx,
    companyId,
    conversationId,
    "outbound",
    envelope,
    plan.content,
    createdAt.toISOString(),
  );
  return { ok: true, conversation_id: conversationId };
}

/** The body of process_ycloud_event, on an open transaction. Exported for tests. */
export async function applyYCloudEvent(
  tx: SqlDb,
  eventId: string,
  eventType: string,
  payload: unknown,
  options?: EventOptions,
): Promise<EventResult> {
  const clock = clockOf(options);
  await recordEvent(tx, eventId, eventType, payload, clock);
  const route = routeEvent(eventType, payload);
  switch (route.route) {
    case "no_message":
      return { ok: true, skipped: "no_message" };
    case "inbound":
      return applyInbound(tx, route.envelope, clock);
    case "outbound":
      return applyOutbound(tx, route.envelope, clock);
    case "ignored":
      return { ok: true, ignored: eventType };
  }
}

async function runEvent(
  db: SqlDb,
  eventId: string,
  eventType: string,
  payload: unknown,
  options?: EventOptions,
  precheck?: (tx: SqlDb) => Promise<void>,
): Promise<EventResult> {
  assertJsonbStorable(payload);
  try {
    return await inTransaction(db, async (tx) => {
      await precheck?.(tx);
      return applyYCloudEvent(tx, eventId, eventType, payload, options);
    });
  } catch (err) {
    // Answered out here, not in the transaction: under XACT_ABORT ON, which the connection sets, a
    // unique violation has already rolled back and a commit would fail with error 3902.
    if (err instanceof DuplicateEvent) return { ok: true, duplicate: true };
    throw err;
  }
}

/**
 * process_ycloud_event. A raised error rolls everything back, the webhook_events row included, and
 * rejects; that failure is what makes YCloud retry.
 */
export function processYCloudEvent(
  db: SqlDb,
  eventId: string,
  eventType: string,
  payload: unknown,
  options?: EventOptions,
): Promise<EventResult> {
  return runEvent(db, eventId, eventType, payload, options);
}

async function asRpcResult(work: () => Promise<EventResult>): Promise<SqlResult<EventResult | null>> {
  try {
    return { data: await work(), error: null, count: null };
  } catch (err) {
    return failure(err);
  }
}

/** The wrappers take their arguments in a list or, as the repository passes them, in an object. */
type EventArgs = { eventId: string; eventType: string; payload: unknown; options?: EventOptions };
type RpcResult = Promise<SqlResult<EventResult | null>>;

/** process_ycloud_webhook_for_account, shaped like the RPC: errors come back, never thrown. */
export function processYCloudWebhookForAccount(
  db: SqlDb,
  args: EventArgs & { accountId: string },
): RpcResult;
export function processYCloudWebhookForAccount(
  db: SqlDb,
  accountId: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  options?: EventOptions,
): RpcResult;
export function processYCloudWebhookForAccount(
  db: SqlDb,
  first: string | (EventArgs & { accountId: string }),
  eventId?: string,
  eventType?: string,
  payload?: unknown,
  options?: EventOptions,
): RpcResult {
  const args =
    typeof first === "string"
      ? { accountId: first, eventId: eventId as string, eventType: eventType as string, payload, options }
      : first;
  return asRpcResult(async () => {
    const { accountId } = args;
    if (!isUuid(accountId)) throw new Error("unknown ycloud account");
    return runEvent(db, args.eventId, remapEventType(args.eventType), args.payload, args.options, async (tx) => {
      const found = await tx.run(sql`SELECT id FROM chatbase.ycloud_accounts
                                     WHERE id = ${accountId} AND is_active = 1`);
      if (found.length === 0) throw new Error("unknown ycloud account");
    });
  });
}

/**
 * process_ycloud_webhook, the legacy secret-checked entry. app_secrets is not migrated, so the
 * secret is the environment's, trimmed as the webhook handler trims it before calling here.
 */
export function processYCloudWebhook(db: SqlDb, args: EventArgs & { secret: string }): RpcResult;
export function processYCloudWebhook(
  db: SqlDb,
  secret: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  options?: EventOptions,
): RpcResult;
export function processYCloudWebhook(
  db: SqlDb,
  first: string | (EventArgs & { secret: string }),
  eventId?: string,
  eventType?: string,
  payload?: unknown,
  options?: EventOptions,
): RpcResult {
  const args =
    typeof first === "string"
      ? { secret: first, eventId: eventId as string, eventType: eventType as string, payload, options }
      : first;
  return asRpcResult(async () => {
    const expected = process.env.YCLOUD_WEBHOOK_SECRET?.trim();
    if (!expected || args.secret !== expected) throw new Error("invalid webhook secret");
    return runEvent(db, args.eventId, remapEventType(args.eventType), args.payload, args.options);
  });
}
