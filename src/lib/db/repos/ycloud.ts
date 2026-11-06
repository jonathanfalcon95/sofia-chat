import type { Db } from "../types";

const ACCOUNT_SELECT =
  "id, name, api_key_encrypted, webhook_secret_encrypted, ycloud_webhook_endpoint_id, api_key_last4, is_active";

const SYNCED_INBOX_SELECT =
  "id, phone_number, ycloud_phone_number_id, name, waba_id, ycloud_account_id";

export async function listYCloudAccounts(db: Db) {
  return db
    .from("ycloud_accounts")
    .select(ACCOUNT_SELECT)
    .order("created_at", { ascending: true });
}

export async function findYCloudAccount(db: Db, accountId: string) {
  return db
    .from("ycloud_accounts")
    .select(ACCOUNT_SELECT)
    .eq("id", accountId)
    .maybeSingle();
}

export async function findYCloudAccountName(db: Db, accountId: string) {
  return db
    .from("ycloud_accounts")
    .select("name")
    .eq("id", accountId)
    .maybeSingle();
}

/** Updates the account and returns the stored row. */
export async function updateYCloudAccount(
  db: Db,
  accountId: string,
  patch: Record<string, unknown>,
) {
  return db
    .from("ycloud_accounts")
    .update(patch)
    .eq("id", accountId)
    .select(ACCOUNT_SELECT)
    .single();
}

export async function insertYCloudAccount(
  db: Db,
  row: Record<string, unknown>,
) {
  return db
    .from("ycloud_accounts")
    .insert(row)
    .select(ACCOUNT_SELECT)
    .single();
}

export async function saveYCloudAccountWebhook(
  db: Db,
  accountId: string,
  patch: Record<string, unknown>,
) {
  return db.from("ycloud_accounts").update(patch).eq("id", accountId);
}

export async function findInboxForCredentials(db: Db, inboxId: string) {
  return db
    .from("inboxes")
    .select("id, phone_number, waba_id, ycloud_account_id")
    .eq("id", inboxId)
    .maybeSingle();
}

/** Links every inbox without a YCloud account to this one. */
export async function assignYCloudAccountToUnlinkedInboxes(
  db: Db,
  accountId: string,
) {
  return db
    .from("inboxes")
    .update({ ycloud_account_id: accountId })
    .is("ycloud_account_id", null);
}

export async function listInboxesForPhoneSync(db: Db) {
  return db.from("inboxes").select(SYNCED_INBOX_SELECT);
}

export async function insertSyncedInbox(
  db: Db,
  row: Record<string, unknown>,
) {
  return db
    .from("inboxes")
    .insert(row)
    .select(SYNCED_INBOX_SELECT)
    .single();
}

export async function updateSyncedInbox(
  db: Db,
  inboxId: string,
  patch: Record<string, unknown>,
) {
  return db.from("inboxes").update(patch).eq("id", inboxId);
}

/** Applies a webhook event received on a specific YCloud account. */
export async function processYCloudWebhookForAccount(
  db: Db,
  args: {
    accountId: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  return db.rpc("process_ycloud_webhook_for_account", {
    p_account_id: args.accountId,
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_payload: args.payload,
  });
}

/** Applies a webhook event received on the legacy, secret-checked endpoint. */
export async function processYCloudWebhook(
  db: Db,
  args: {
    secret: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  return db.rpc("process_ycloud_webhook", {
    p_secret: args.secret,
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_payload: args.payload,
  });
}
