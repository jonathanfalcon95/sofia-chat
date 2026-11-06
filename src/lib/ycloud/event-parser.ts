/**
 * Pure port of the decisions in the PL/pgSQL function process_ycloud_event: everything that turns a
 * YCloud event into message fields, body text and merged JSON. No database here; the statements
 * live in src/lib/db/sqlserver/webhook.ts.
 *
 * JSON values follow Postgres: `undefined` is SQL NULL, `null` is the jsonb value null, and they
 * behave differently (`coalesce(x->'k', ...)` does not skip a jsonb null).
 */

export class PgRaisedError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PgRaisedError";
    this.code = code;
  }
}

// jsonb operators ------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `json -> 'key'`: SQL NULL on non-objects and missing keys, jsonb null on a null value. */
export function arrow(json: unknown, key: string): unknown {
  if (!isObject(json) || !Object.prototype.hasOwnProperty.call(json, key)) return undefined;
  return json[key];
}

/** `json ->> 'key'`. */
export function arrowText(json: unknown, key: string): string | null {
  const value = arrow(json, key);
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : jsonbText(value);
}

/** Postgres numeric text never uses exponents. */
function numberText(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = "", exponent] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** jsonb orders object keys by byte length, then bytewise. */
function compareJsonbKeys(a: string, b: string): number {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return left.length - right.length;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** jsonb's text form, which `->>` returns for numbers, booleans and nested values. */
export function jsonbText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  const object = value as Record<string, unknown>;
  const fields = Object.keys(object)
    .sort(compareJsonbKeys)
    .map((key) => `${JSON.stringify(key)}: ${jsonbText(object[key])}`);
  return `{${fields.join(", ")}}`;
}

/** `a || b`: shallow merge with the right side winning for objects, array concatenation otherwise. */
export function jsonbConcat(left: unknown, right: unknown): unknown {
  if (isObject(left) && isObject(right)) return { ...left, ...right };
  return [
    ...(Array.isArray(left) ? left : [left]),
    ...(Array.isArray(right) ? right : [right]),
  ];
}

/**
 * The jsonb argument cast rejected these before the function ran, so the event failed. Azure SQL
 * would store them.
 */
export function assertJsonbStorable(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw new PgRaisedError("unsupported Unicode escape sequence", "22P05");
    }
    if (!value.isWellFormed()) {
      throw new PgRaisedError("invalid input syntax for type json", "22P02");
    }
  } else if (Array.isArray(value)) {
    value.forEach(assertJsonbStorable);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonbStorable(key);
      assertJsonbStorable(item);
    }
  }
}

// Text functions -------------------------------------------------------------

/** Postgres `trim(x)` strips spaces only, unlike String.prototype.trim. */
export function pgTrim(text: string | null): string | null {
  return text === null ? null : text.replace(/^ +| +$/g, "");
}

export function nullIfEmpty(text: string | null): string | null {
  return text === "" ? null : text;
}

/** `left(x, n)` counts code points, not UTF-16 units. */
export function pgLeft(text: string, count: number): string {
  return Array.from(text).slice(0, count).join("");
}

/** `regexp_replace(x, '[^0-9]', '', 'g')`. */
export function digitsOnly(text: string): string {
  return text.replace(/[^0-9]/g, "");
}

/** Bodies like `[image]`, written when the real content was not known yet. */
export function isPlaceholderBody(body: string): boolean {
  return /^\[[a-z_]+\]$/.test(body);
}

// Timestamps -----------------------------------------------------------------

const TIMESTAMP =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|UTC|GMT|[+-]\d{1,2}(?::?\d{2}(?::?\d{2})?)?)?$/i;

function offsetMillis(zone: string | undefined): number | null {
  if (!zone || /^[a-z]/i.test(zone)) return 0;
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(zone);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (hours > 15 || minutes > 59 || seconds > 59) return null;
  const size = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return match[1] === "-" ? -size : size;
}

/**
 * `x::timestamptz`, which raises where `new Date` would give Invalid Date. Takes ISO-8601 shapes;
 * text without a zone is UTC, the Supabase session zone. Stored precision is milliseconds.
 */
export function parseTimestamptz(text: string): Date {
  const syntax = () =>
    new PgRaisedError(
      `invalid input syntax for type timestamp with time zone: "${text}"`,
      "22007",
    );
  const range = () =>
    new PgRaisedError(`date/time field value out of range: "${text}"`, "22008");

  const match = TIMESTAMP.exec(text.replace(/^\s+|\s+$/g, ""));
  if (!match) throw syntax();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((part) => Number(part ?? 0));
  const offset = offsetMillis(match[8]);
  if (offset === null) throw syntax();

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const fraction = match[7] ? Math.round(Number(`0.${match[7]}`) * 1000) : 0;
  const midnight24 = hour === 24 && minute === 0 && second === 0 && fraction === 0;
  if (
    year === 0 ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    (hour > 23 && !midnight24) ||
    minute > 59 ||
    second > 60
  ) {
    throw range();
  }
  return new Date(
    date.getTime() + (hour * 3600 + minute * 60 + second) * 1000 + fraction - offset,
  );
}

/** A timestamptz inside jsonb: `2026-01-02T03:04:05.12+00:00`, trailing zeros removed. */
export function pgJsonTimestamp(date: Date): string {
  const iso = date.toISOString();
  const fraction = iso.slice(20, 23).replace(/0+$/, "");
  return `${iso.slice(0, 19)}${fraction ? `.${fraction}` : ""}+00:00`;
}

/** `coalesce((msg->>'createTime')::timestamptz, now())`. An empty string raises here. */
export function inboundTimestamp(msg: unknown, now: Date): Date {
  const createTime = arrowText(msg, "createTime");
  return createTime === null ? now : parseTimestamptz(createTime);
}

/** coalesce over nullif(sendTime, '') then nullif(createTime, ''): unguarded, and lazy. */
export function outboundTimestamp(msg: unknown, now: Date): Date {
  const sendTime = nullIfEmpty(arrowText(msg, "sendTime"));
  if (sendTime !== null) return parseTimestamptz(sendTime);
  const createTime = nullIfEmpty(arrowText(msg, "createTime"));
  return createTime === null ? now : parseTimestamptz(createTime);
}

function guardedTimestamp(text: string | null): Date | null {
  if (text === null) return null;
  try {
    return parseTimestamptz(text);
  } catch {
    return null;
  }
}

/**
 * The trigger messages_apply_send_time on an insert of an outbound message with sent_by null: the
 * `created_at` to use, or null to keep the given one. Bad values are swallowed. `rawPayload` is
 * the stored raw_payload, undefined when SQL NULL.
 */
export function applySendTime(rawPayload: unknown): Date | null {
  if (rawPayload === undefined) return null;
  return (
    guardedTimestamp(nullIfEmpty(arrowText(rawPayload, "sendTime"))) ??
    guardedTimestamp(nullIfEmpty(arrowText(rawPayload, "createTime")))
  );
}

// Routing --------------------------------------------------------------------

/** What the wrappers do before calling the function: Business App echoes reuse the outbound path. */
export function remapEventType(eventType: string): string {
  return eventType === "whatsapp.smb.message.echoes" ||
    eventType === "whatsapp.smb.message.created"
    ? "whatsapp.message.updated"
    : eventType;
}

export type Envelope = {
  /** The whole message, stored as raw_payload. */
  msg: unknown;
  from: string;
  to: string;
  msgId: string | null;
  wamid: string | null;
  replyTo: string | null;
  msgType: string;
  status: string;
};

export type EventRoute =
  | { route: "ignored" }
  | { route: "no_message" }
  | { route: "inbound"; envelope: Envelope }
  | { route: "outbound"; envelope: Envelope };

function firstText(json: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const value = nullIfEmpty(arrowText(json, key));
    if (value !== null) return value;
  }
  return null;
}

function envelopeOf(msg: unknown, defaultStatus: string): Envelope {
  const msgId = arrowText(msg, "id") ?? arrowText(msg, "wamid");
  return {
    msg,
    from: arrowText(msg, "from") ?? "",
    to: arrowText(msg, "to") ?? "",
    msgId,
    wamid:
      nullIfEmpty(arrowText(msg, "wamid")) ??
      (msgId !== null && msgId.startsWith("wamid.") ? msgId : null),
    replyTo: firstText(arrow(msg, "context"), ["message_id", "id", "wamid"]),
    msgType: arrowText(msg, "type") ?? "text",
    status: arrowText(msg, "status") ?? defaultStatus,
  };
}

export function routeEvent(eventType: string, payload: unknown): EventRoute {
  if (
    eventType === "whatsapp.inbound_message.received" ||
    eventType === "whatsapp.inbound.message"
  ) {
    // A jsonb null is not SQL NULL: `coalesce` keeps it, and the event goes on with no fields.
    const inboundMsg = arrow(payload, "whatsappInboundMessage");
    const msg = inboundMsg !== undefined ? inboundMsg : arrow(payload, "whatsappMessage");
    if (msg === undefined) return { route: "no_message" };
    return { route: "inbound", envelope: envelopeOf(msg, "received") };
  }
  if (
    eventType === "whatsapp.message.updated" ||
    eventType === "whatsapp.smb.message.echoes" ||
    eventType === "whatsapp.smb.message.created"
  ) {
    const msg = arrow(payload, "whatsappMessage");
    if (msg === undefined) return { route: "no_message" };
    return { route: "outbound", envelope: envelopeOf(msg, "updated") };
  }
  return { route: "ignored" };
}

// Inbox matching -------------------------------------------------------------

export type InboxRow = { id: string; company_id: string | null; phone_number: string };

/**
 * Exact, without '+', or equal digits. The first two imply the third, so digits decide, on every
 * path. `limit 1` had no order; callers pass inboxes in a stable order.
 */
export function matchInbox<T extends { phone_number: string }>(
  inboxes: readonly T[],
  phone: string,
): T | null {
  const digits = digitsOnly(phone);
  return inboxes.find((inbox) => digitsOnly(inbox.phone_number) === digits) ?? null;
}

// Message content ------------------------------------------------------------

export type MessageContent = {
  type: string;
  body: string;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSha256: string | null;
};

const MEDIA_LABELS: Record<string, string> = {
  audio: "Nota de voz",
  image: "Imagen",
  video: "Video",
  sticker: "Sticker",
  document: "Documento",
};

function interactiveBody(content: unknown): string {
  const interactive = arrow(content, "interactive");
  const text =
    nullIfEmpty(pgTrim(arrowText(arrow(interactive, "body"), "text"))) ?? "";
  const parameters = arrow(arrow(interactive, "action"), "parameters");
  const url = nullIfEmpty(arrowText(parameters, "url"));
  const display =
    nullIfEmpty(pgTrim(arrowText(parameters, "display_text"))) ?? "Abrir enlace";
  if (text !== "" && url !== null) return `${text}\n${display}: ${url}`;
  if (url !== null) return `${display}: ${url}`;
  return text === "" ? "Mensaje interactivo" : text;
}

/** `jsonb_array_elements(coalesce(x, '[]'))`: a missing key is empty, any non-array raises. */
function arrayElements(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw new PgRaisedError(
    `cannot extract elements from ${isObject(value) ? "an object" : "a scalar"}`,
    "22023",
  );
}

/** `coalesce(jsonb_array_length(x), 0)`: a missing key is 0, any non-array raises. */
function arrayLength(value: unknown): number {
  if (value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  throw new PgRaisedError(
    `cannot get array length of ${isObject(value) ? "a non-array" : "a scalar"}`,
    "22023",
  );
}

function contactsBody(content: unknown): string {
  let body = "";
  for (const contact of arrayElements(arrow(content, "contacts"))) {
    const name = arrow(contact, "name");
    const fullName = ["first_name", "middle_name", "last_name"]
      .map((key) => nullIfEmpty(arrowText(name, key)))
      .filter((part) => part !== null)
      .join(" ");
    const line =
      nullIfEmpty(pgTrim(arrowText(name, "formatted_name"))) ??
      nullIfEmpty(pgTrim(fullName)) ??
      "Contacto";
    body = body === "" ? line : `${body}\n${line}`;
    for (const phone of arrayElements(arrow(contact, "phones"))) {
      const number = firstText(phone, ["phone", "wa_id"]);
      if (number === null) continue;
      const type = nullIfEmpty(arrowText(phone, "type"));
      body += `\n${type === null ? number : `${type}: ${number}`}`;
    }
  }
  return body === "" ? "Contacto compartido" : body;
}

function locationBody(content: unknown): string {
  const location = arrow(content, "location");
  const field = (key: string) => nullIfEmpty(pgTrim(arrowText(location, key)));
  const name = field("name");
  const address = field("address");
  const latitude = field("latitude");
  const longitude = field("longitude");
  if (name !== null && address !== null) return `📍 ${name}\n${address}`;
  if (name !== null) return `📍 ${name}`;
  if (address !== null) return `📍 ${address}`;
  if (latitude !== null && longitude !== null) {
    return `📍 Ubicación: ${latitude}, ${longitude}`;
  }
  return "📍 Ubicación compartida";
}

function orderBody(content: unknown): string {
  const order = arrow(content, "order");
  const items = arrayLength(arrow(order, "product_items"));
  const text = nullIfEmpty(pgTrim(arrowText(order, "text")));
  if (text !== null) return text;
  return items > 0
    ? `🛒 Pedido de catálogo (${items} artículo${items > 1 ? "s" : ""})`
    : "🛒 Pedido de catálogo";
}

/** The new number of a `user_changed_number` system message, without its leading '+'. */
function changedNumber(content: unknown): string | null {
  const system = arrow(content, "system");
  const waId = nullIfEmpty(arrowText(system, "wa_id"));
  if (arrowText(system, "type") !== "user_changed_number" || waId === null) return null;
  return waId.replace(/^\+/, "");
}

function systemBody(content: unknown): string {
  const number = changedNumber(content);
  if (number !== null) return `El contacto cambió de número a +${number}`;
  return (
    nullIfEmpty(arrowText(arrow(content, "system"), "body")) ??
    "Mensaje del sistema de WhatsApp"
  );
}

/** Only the inbound path knows `system` and `unsupported`; outbound ones get `[system]`. */
function specialBody(type: string, content: unknown, inbound: boolean): string | null {
  switch (type) {
    case "interactive":
      return interactiveBody(content);
    case "contacts":
      return contactsBody(content);
    case "location":
      return locationBody(content);
    case "order":
      return orderBody(content);
    case "system":
      return inbound ? systemBody(content) : null;
    case "unsupported":
      return inbound
        ? "WhatsApp no compartió este mensaje (tipo no disponible para negocios)."
        : null;
    default:
      return null;
  }
}

function formatContent(type: string, content: unknown, inbound: boolean): MessageContent {
  const none = { mediaUrl: null, mediaMime: null, mediaFilename: null, mediaSha256: null };
  const special = specialBody(type, content, inbound);
  if (special !== null) return { type, body: special, ...none };

  if (Object.prototype.hasOwnProperty.call(MEDIA_LABELS, type)) {
    const media = arrow(content, type);
    if (!isObject(media)) return { type, body: MEDIA_LABELS[type], ...none };
    const mediaFilename = nullIfEmpty(arrowText(media, "filename"));
    return {
      type,
      body: nullIfEmpty(arrowText(media, "caption")) ?? mediaFilename ?? MEDIA_LABELS[type],
      mediaUrl: nullIfEmpty(arrowText(media, "link")),
      mediaMime: firstText(media, ["mime_type", "mimeType"]),
      mediaFilename,
      mediaSha256: nullIfEmpty(arrowText(media, "sha256")),
    };
  }

  const body =
    arrowText(arrow(content, "text"), "body") ??
    arrowText(content, "caption") ??
    `[${type}]`;
  return { type, body, ...none };
}

// Inbound plan ---------------------------------------------------------------

export type ReactionPlan = { kind: "reaction"; target: string | null; emoji: string };

export function planReaction(envelope: Envelope): ReactionPlan {
  const reaction = arrow(envelope.msg, "reaction");
  return {
    kind: "reaction",
    target: firstText(reaction, ["message_id", "wamid"]) ?? envelope.replyTo,
    emoji: arrowText(reaction, "emoji") ?? "",
  };
}

export type PlannedContact = { phone: string; name: string; metadata: Record<string, unknown> };

export function planInboundContact(envelope: Envelope): PlannedContact {
  const { msg, from } = envelope;
  const profileName = nullIfEmpty(
    pgTrim(
      arrowText(arrow(msg, "customerProfile"), "name") ??
        arrowText(msg, "customerProfileName") ??
        "",
    ),
  );
  const fromUserId = nullIfEmpty(pgTrim(arrowText(msg, "fromUserId") ?? ""));
  return {
    phone: from,
    name: profileName ?? from,
    metadata: fromUserId === null ? {} : { ycloud_from_user_id: fromUserId },
  };
}

export type InboundPlan =
  | ReactionPlan
  | { kind: "revoke"; target: string | null }
  | {
      kind: "message";
      content: MessageContent;
      contact: PlannedContact;
      /** The contact's new phone number when this message reports a change of number. */
      newPhone: string | null;
      preview: string;
    };

/**
 * What an inbound message does. Call it once the inbox is known: the SQL only reads the content
 * after the inbox checks, so a malformed `contacts` or `order` must not fail a skipped event.
 */
export function planInboundMessage(envelope: Envelope): InboundPlan {
  const { msg, msgType } = envelope;
  if (msgType === "reaction") return planReaction(envelope);
  if (msgType === "revoke") {
    return {
      kind: "revoke",
      target:
        firstText(arrow(msg, "revoke"), ["message_id", "wamid"]) ?? envelope.replyTo,
    };
  }

  let contentMsg = msg;
  let type = msgType;
  let content: MessageContent;
  if (msgType === "edit") {
    const edited = arrow(arrow(msg, "edit"), "message");
    if (isObject(edited)) {
      contentMsg = edited;
      type = arrowText(edited, "type") ?? "text";
      content = formatContent(type, contentMsg, true);
    } else {
      type = "text";
      content = {
        type,
        body: "Mensaje editado",
        mediaUrl: null,
        mediaMime: null,
        mediaFilename: null,
        mediaSha256: null,
      };
    }
  } else {
    content = formatContent(type, contentMsg, true);
  }

  const number = type === "system" ? changedNumber(contentMsg) : null;
  return {
    kind: "message",
    content,
    contact: planInboundContact(envelope),
    newPhone: number === null ? null : `+${number}`,
    preview: pgLeft(content.body, 200),
  };
}

// Outbound plan --------------------------------------------------------------

export type OutboundPlan = ReactionPlan | { kind: "message"; content: MessageContent; preview: string };

/** The SQL formats outbound content before any lookup, so a malformed `order` always fails. */
export function planOutboundMessage(envelope: Envelope): OutboundPlan {
  if (envelope.msgType === "reaction") return planReaction(envelope);
  const content = formatContent(envelope.msgType, envelope.msg, false);
  return { kind: "message", content, preview: pgLeft(content.body, 200) };
}

// Merges with stored rows ----------------------------------------------------

/**
 * Removes the sender's previous reaction and adds the new one, an empty emoji only removes.
 * Three-valued logic of `where not (direction = x and (...))`: an element with no direction makes
 * the condition NULL, not false, so it is dropped when the sender matches.
 */
export function applyReaction(
  reactions: unknown,
  reaction: { emoji: string; from: string; direction: "inbound" | "outbound" },
): unknown[] {
  const { emoji, from, direction } = reaction;
  const digits = digitsOnly(from);
  const kept = (Array.isArray(reactions) ? reactions : []).filter((element) => {
    const elementDirection = arrowText(element, "direction");
    const elementFrom = arrowText(element, "from");
    const sameSender = elementFrom === from || digitsOnly(elementFrom ?? "") === digits;
    const removed = (elementDirection === null || elementDirection === direction) && sameSender;
    return !removed;
  });
  return emoji === "" ? kept : [...kept, { emoji, from, direction }];
}

export const REVOKED_BODY = "Mensaje eliminado";

export function revokedRawPayload(rawPayload: unknown, revokeEvent: unknown, now: Date): unknown {
  return jsonbConcat(rawPayload === undefined ? {} : rawPayload, {
    revoked_at: pgJsonTimestamp(now),
    revoke_event: revokeEvent,
  });
}

export type StoredContact = { name: string | null; phone_number: string; metadata: unknown };

/** The `on conflict` of the inbound contact insert. */
export function mergeInboundContact(existing: StoredContact, planned: PlannedContact) {
  const replacesName =
    nullIfEmpty(pgTrim(planned.name)) !== null &&
    planned.name !== planned.phone &&
    (existing.name === null || existing.name === "" || existing.name === existing.phone_number);
  return {
    name: replacesName ? planned.name : existing.name,
    metadata: jsonbConcat(existing.metadata ?? {}, planned.metadata),
  };
}

/** Inbound overwrites the times with no ordering guard, and a closed conversation reopens. */
export function mergeInboundConversation(
  existing: { status: string; unread_count: number },
  at: Date,
  preview: string,
) {
  return {
    ...newInboundConversation(at, preview),
    status: existing.status === "closed" ? "open" : existing.status,
    unreadCount: existing.unread_count + 1,
  };
}

export function newInboundConversation(at: Date, preview: string) {
  return {
    lastMessageAt: at.toISOString(),
    lastInboundAt: at.toISOString(),
    windowExpiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    preview,
    status: "open",
    unreadCount: 1,
  };
}

/** `greatest` ignores NULLs; the preview follows when the message is not older. */
export function mergeOutboundConversation(
  existing: { last_message_at: string | Date | null; last_message_preview: string | null },
  at: Date,
  preview: string,
) {
  const stored = existing.last_message_at === null ? null : new Date(existing.last_message_at);
  const isLatest = stored === null || at.getTime() >= stored.getTime();
  return {
    lastMessageAt: (isLatest ? at : (stored as Date)).toISOString(),
    preview: isLatest ? preview : existing.last_message_preview,
  };
}

export type StoredMessage = {
  body: string | null;
  wamid: string | null;
  reply_to_wamid: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_filename: string | null;
  media_sha256: string | null;
  /** undefined when the column is NULL. */
  raw_payload: unknown;
};

export type MessagePatch = {
  status: string;
  rawPayload: unknown;
  wamid: string | null;
  replyTo: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  mediaSha256: string | null;
  body: string | null;
};

/** The `on conflict` of the inbound insert: incoming values win, and a placeholder body yields. */
export function mergeInboundMessage(
  existing: StoredMessage,
  envelope: Envelope,
  content: MessageContent,
): MessagePatch {
  return {
    status: envelope.status,
    rawPayload: envelope.msg,
    wamid: envelope.wamid ?? existing.wamid,
    replyTo: envelope.replyTo ?? existing.reply_to_wamid,
    mediaUrl: content.mediaUrl ?? existing.media_url,
    mediaMime: content.mediaMime ?? existing.media_mime,
    mediaFilename: content.mediaFilename ?? existing.media_filename,
    mediaSha256: content.mediaSha256 ?? existing.media_sha256,
    body:
      existing.body === null || isPlaceholderBody(existing.body) ? content.body : existing.body,
  };
}

/** Keeps the rich blocks the app stored when it sent the message, under `send`. */
function outboundRawPayload(stored: unknown, envelope: Envelope): unknown {
  const { msg, wamid } = envelope;
  const send = arrow(stored, "send");
  if (
    isObject(stored) &&
    (arrow(stored, "storagePath") !== undefined ||
      arrow(stored, "upload") !== undefined ||
      send !== undefined)
  ) {
    return jsonbConcat(stored, {
      send: jsonbConcat(send === undefined ? {} : send, msg),
      wamid: wamid ?? arrowText(stored, "wamid"),
    });
  }
  if (isObject(stored) && isObject(msg)) return jsonbConcat(stored, msg);
  return msg;
}

/**
 * The update of an existing outbound message. Status has no ordering guard, stored media wins, and
 * a placeholder body only yields to a real one.
 */
export function mergeOutboundMessage(
  existing: StoredMessage,
  envelope: Envelope,
  content: MessageContent,
): MessagePatch {
  const replacesBody =
    (existing.body === null || isPlaceholderBody(existing.body)) &&
    !isPlaceholderBody(content.body);
  return {
    status: envelope.status,
    rawPayload: outboundRawPayload(existing.raw_payload, envelope),
    wamid: envelope.wamid ?? existing.wamid,
    replyTo: envelope.replyTo ?? existing.reply_to_wamid,
    mediaUrl: existing.media_url ?? content.mediaUrl,
    mediaMime: existing.media_mime ?? content.mediaMime,
    mediaFilename: existing.media_filename ?? content.mediaFilename,
    mediaSha256: existing.media_sha256 ?? content.mediaSha256,
    body: replacesBody ? content.body : existing.body,
  };
}
