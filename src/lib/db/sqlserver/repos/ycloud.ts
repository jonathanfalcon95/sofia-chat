import { hasPermission, scope, type Access } from "../access";
import { accessOf, done, type SqlDb } from "../db";
import { isUuid, raw, sql, where } from "../sql";
import {
  accessKey,
  insertStatement,
  isSystem,
  maybeOne,
  one,
  outputInserted,
  rlsViolation,
  rows,
  setClause,
  type WritableTable,
} from "./shared";

const ACCOUNT_COLUMNS = [
  "id",
  "name",
  "api_key_encrypted",
  "webhook_secret_encrypted",
  "ycloud_webhook_endpoint_id",
  "api_key_last4",
  "is_active",
];
const ACCOUNT_SELECT = raw(ACCOUNT_COLUMNS.join(", "));

const SYNCED_INBOX_COLUMNS = [
  "id",
  "phone_number",
  "ycloud_phone_number_id",
  "name",
  "waba_id",
  "ycloud_account_id",
];

const YCLOUD_ACCOUNTS: WritableTable = {
  name: "chatbase.ycloud_accounts",
  columns: [...ACCOUNT_COLUMNS, "created_at", "updated_at"],
  timestamps: ["created_at", "updated_at"],
  touchesUpdatedAt: true,
};

const INBOXES: WritableTable = {
  name: "chatbase.inboxes",
  columns: [...SYNCED_INBOX_COLUMNS, "company_id", "is_active", "created_at", "updated_at"],
  timestamps: ["created_at", "updated_at"],
  touchesUpdatedAt: true,
};

/** ycloud_accounts has RLS and no policy: a user reads and changes nothing. */
export async function listYCloudAccounts(db: SqlDb) {
  return rows(async () => {
    if (!isSystem(db)) return [];
    return db.run(sql`
      SELECT ${ACCOUNT_SELECT} FROM chatbase.ycloud_accounts ORDER BY created_at ASC`);
  });
}

export async function findYCloudAccount(db: SqlDb, accountId: string) {
  return maybeOne(async () => {
    if (!isSystem(db) || !isUuid(accountId)) return [];
    return db.run(sql`
      SELECT ${ACCOUNT_SELECT} FROM chatbase.ycloud_accounts WHERE id = ${accountId}`);
  });
}

export async function findYCloudAccountName(db: SqlDb, accountId: string) {
  return maybeOne(async () => {
    if (!isSystem(db) || !isUuid(accountId)) return [];
    return db.run(sql`SELECT name FROM chatbase.ycloud_accounts WHERE id = ${accountId}`);
  });
}

/** Updates the account and returns the stored row. */
export async function updateYCloudAccount(
  db: SqlDb,
  accountId: string,
  patch: Record<string, unknown>,
) {
  return one(async () => {
    if (!isSystem(db) || !isUuid(accountId)) return [];
    const set = setClause(YCLOUD_ACCOUNTS, patch);
    if (!set) return [];
    return db.run(sql`
      UPDATE chatbase.ycloud_accounts SET ${set}
      ${outputInserted(ACCOUNT_COLUMNS)}
      WHERE id = ${accountId}`);
  });
}

export async function insertYCloudAccount(db: SqlDb, row: Record<string, unknown>) {
  return one(async () => {
    if (!isSystem(db)) throw rlsViolation();
    return db.run(insertStatement(YCLOUD_ACCOUNTS, row, ACCOUNT_COLUMNS));
  });
}

export async function saveYCloudAccountWebhook(
  db: SqlDb,
  accountId: string,
  patch: Record<string, unknown>,
) {
  return done(async () => {
    if (!isSystem(db) || !isUuid(accountId)) return;
    const set = setClause(YCLOUD_ACCOUNTS, patch);
    if (!set) return;
    await db.run(sql`UPDATE chatbase.ycloud_accounts SET ${set} WHERE id = ${accountId}`);
  });
}

export async function findInboxForCredentials(db: SqlDb, inboxId: string) {
  return maybeOne(async () => {
    if (!isUuid(inboxId)) return [];
    const access = await accessOf(db);
    return db.run(sql`
      SELECT id, phone_number, waba_id, ycloud_account_id FROM chatbase.inboxes
      ${where([
        sql`id = ${inboxId}`,
        access ? scope.inboxesRead(access, "id", "company_id") : null,
      ])}`);
  });
}

/** inboxes_update USING: platform admins and inboxes.manage on the inbox's company. */
function writableInboxes(access: Access | null) {
  return access ? scope.companyWith(access, "company_id", "inboxes.manage") : null;
}

/** inboxes_update WITH CHECK: an update can't move an inbox to a company the user can't manage. */
function checkMovedInbox(access: Access | null, patch: Record<string, unknown>) {
  if (
    access &&
    patch.company_id !== undefined &&
    !hasPermission(access, accessKey(patch.company_id), "inboxes.manage")
  ) {
    throw rlsViolation();
  }
}

/** Links every inbox without a YCloud account to this one. */
export async function assignYCloudAccountToUnlinkedInboxes(db: SqlDb, accountId: string) {
  return done(async () => {
    const access = await accessOf(db);
    await db.run(sql`
      UPDATE chatbase.inboxes
      SET ycloud_account_id = ${accountId}, updated_at = SYSUTCDATETIME()
      ${where([sql`ycloud_account_id IS NULL`, writableInboxes(access)])}`);
  });
}

export async function listInboxesForPhoneSync(db: SqlDb) {
  return rows(async () => {
    const access = await accessOf(db);
    return db.run(sql`
      SELECT ${raw(SYNCED_INBOX_COLUMNS.join(", "))} FROM chatbase.inboxes
      ${where([access ? scope.inboxesRead(access, "id", "company_id") : null])}`);
  });
}

export async function insertSyncedInbox(db: SqlDb, row: Record<string, unknown>) {
  return one(async () => {
    const access = await accessOf(db);
    if (access && !hasPermission(access, accessKey(row.company_id), "inboxes.manage")) {
      throw rlsViolation();
    }
    return db.run(insertStatement(INBOXES, row, SYNCED_INBOX_COLUMNS));
  });
}

export async function updateSyncedInbox(
  db: SqlDb,
  inboxId: string,
  patch: Record<string, unknown>,
) {
  return done(async () => {
    if (!isUuid(inboxId)) return;
    const access = await accessOf(db);
    checkMovedInbox(access, patch);
    const set = setClause(INBOXES, patch);
    if (!set) return;
    await db.run(sql`
      UPDATE chatbase.inboxes SET ${set}
      ${where([sql`id = ${inboxId}`, writableInboxes(access)])}`);
  });
}
