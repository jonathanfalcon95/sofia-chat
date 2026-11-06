import { FALSE_SQL, TRUE_SQL, raw, sql, uuidList, type SqlFragment } from "./sql.ts";

/**
 * What a user may reach: the port of the RLS helpers is_platform_admin, has_company_access,
 * has_permission and has_inbox_access. Built once per request from the rows in `loadAccess`.
 */
export type Access = {
  userId: string;
  isPlatformAdmin: boolean;
  /** Companies with an active membership. */
  companyIds: string[];
  permissionsByCompany: Map<string, Set<string>>;
  /** Result of has_inbox_access for every inbox in the database. */
  inboxIds: string[];
  /** Inbox id to company id, for every inbox with a company. */
  inboxCompany: Map<string, string>;
};

export type AccessRows = {
  userId: string;
  isPlatformAdmin: boolean;
  memberships: Array<{ id: string; companyId: string }>;
  permissions: Array<{ membershipId: string; code: string }>;
  membershipInboxes: Array<{ membershipId: string; inboxId: string }>;
  inboxes: Array<{ id: string; companyId: string | null }>;
};

export function buildAccess(rows: AccessRows): Access {
  const permissionsByCompany = new Map<string, Set<string>>();
  const companyOfMembership = new Map<string, string>();
  for (const m of rows.memberships) {
    companyOfMembership.set(m.id, m.companyId);
    if (!permissionsByCompany.has(m.companyId)) {
      permissionsByCompany.set(m.companyId, new Set());
    }
  }
  for (const p of rows.permissions) {
    const company = companyOfMembership.get(p.membershipId);
    if (company) permissionsByCompany.get(company)?.add(p.code);
  }

  const inboxCompany = new Map<string, string>();
  for (const inbox of rows.inboxes) {
    if (inbox.companyId) inboxCompany.set(inbox.id, inbox.companyId);
  }

  const assigned = new Set<string>();
  for (const link of rows.membershipInboxes) {
    // The link only counts through a membership of the inbox's own company.
    const company = companyOfMembership.get(link.membershipId);
    if (company && inboxCompany.get(link.inboxId) === company) assigned.add(link.inboxId);
  }

  const inboxIds = rows.isPlatformAdmin
    ? rows.inboxes.map((inbox) => inbox.id)
    : rows.inboxes
        .filter((inbox) => {
          if (!inbox.companyId || !permissionsByCompany.has(inbox.companyId)) return false;
          return (
            permissionsByCompany.get(inbox.companyId)!.has("inboxes.manage") ||
            assigned.has(inbox.id)
          );
        })
        .map((inbox) => inbox.id);

  return {
    userId: rows.userId,
    isPlatformAdmin: rows.isPlatformAdmin,
    companyIds: [...permissionsByCompany.keys()],
    permissionsByCompany,
    inboxIds,
    inboxCompany,
  };
}

export function hasCompanyAccess(access: Access, companyId: string | null | undefined) {
  if (access.isPlatformAdmin) return true;
  return Boolean(companyId && access.permissionsByCompany.has(companyId));
}

export function hasPermission(
  access: Access,
  companyId: string | null | undefined,
  permission: string,
) {
  if (access.isPlatformAdmin) return true;
  return Boolean(companyId && access.permissionsByCompany.get(companyId)?.has(permission));
}

/**
 * May the user reach this inbox's conversations and what hangs from them? Stricter than the
 * has_inbox_access helper on purpose: every policy on messages, notes and conversation_tags reads
 * `conversations` under conversations_select, and writes need the row to be selectable too, so in
 * Postgres they all also require conversations.view.
 */
export function hasInboxAccess(access: Access, inboxId: string | null | undefined) {
  if (access.isPlatformAdmin) return true;
  return Boolean(inboxId && inboxesWithPermission(access, "conversations.view").includes(inboxId));
}

/** Companies where the user holds any of these permissions. */
export function companiesWithPermission(access: Access, ...permissions: string[]) {
  return [...access.permissionsByCompany.entries()]
    .filter(([, held]) => permissions.some((p) => held.has(p)))
    .map(([company]) => company);
}

/** Inboxes reachable by has_inbox_access whose company also grants the permission. */
export function inboxesWithPermission(access: Access, permission: string) {
  if (access.isPlatformAdmin) return access.inboxIds;
  return access.inboxIds.filter((inbox) =>
    hasPermission(access, access.inboxCompany.get(inbox), permission),
  );
}

/** An anonymous caller has an empty user id, which SQL Server can't compare to a uuid column. */
const UUID_SHAPE = /^[0-9a-f-]{36}$/i;

function inList(column: string, ids: readonly string[]): SqlFragment {
  return ids.length ? sql`${raw(column)} IN ${uuidList(ids)}` : FALSE_SQL;
}

/** The RLS USING clauses, as SQL conditions. System callers never reach these. */
export const scope = {
  /** companies, company_memberships, contacts, tags, contact_tags through contacts. */
  company(access: Access, column: string): SqlFragment {
    return access.isPlatformAdmin ? TRUE_SQL : inList(column, access.companyIds);
  },
  companyWith(access: Access, column: string, ...permissions: string[]): SqlFragment {
    return access.isPlatformAdmin
      ? TRUE_SQL
      : inList(column, companiesWithPermission(access, ...permissions));
  },
  /** messages, conversation_notes, conversation_tags, and conversation writes. See hasInboxAccess. */
  inbox(access: Access, column: string): SqlFragment {
    return access.isPlatformAdmin
      ? TRUE_SQL
      : inList(column, inboxesWithPermission(access, "conversations.view"));
  },
  /** conversations_select: inbox access and conversations.view on its company. */
  conversationsRead(access: Access, inboxColumn: string): SqlFragment {
    return access.isPlatformAdmin
      ? TRUE_SQL
      : inList(inboxColumn, inboxesWithPermission(access, "conversations.view"));
  },
  /** inboxes_select: inbox access or inboxes.manage on its company. */
  inboxesRead(access: Access, idColumn: string, companyColumn: string): SqlFragment {
    if (access.isPlatformAdmin) return TRUE_SQL;
    const managed = companiesWithPermission(access, "inboxes.manage");
    return sql`(${inList(idColumn, access.inboxIds)} OR (${raw(companyColumn)} IS NOT NULL AND ${inList(companyColumn, managed)}))`;
  },
  /** profiles_select: yourself, or anyone with an active membership in one of your companies. */
  profilesRead(access: Access, idColumn: string): SqlFragment {
    if (access.isPlatformAdmin) return TRUE_SQL;
    if (!UUID_SHAPE.test(access.userId)) return FALSE_SQL;
    return sql`(${raw(idColumn)} = ${access.userId} OR EXISTS (
      SELECT 1 FROM chatbase.company_memberships m2
      WHERE m2.user_id = ${raw(idColumn)} AND m2.is_active = 1
        AND ${inList("m2.company_id", access.companyIds)}))`;
  },
  /** roles_select: templates for everyone, company roles for its members. */
  rolesRead(access: Access, companyColumn: string): SqlFragment {
    if (access.isPlatformAdmin) return TRUE_SQL;
    return sql`(${raw(companyColumn)} IS NULL OR ${inList(companyColumn, access.companyIds)})`;
  },
  /** tickets_select: tickets.view or tickets.manage on its company. */
  ticketsRead(access: Access, companyColumn: string): SqlFragment {
    return access.isPlatformAdmin
      ? TRUE_SQL
      : inList(companyColumn, companiesWithPermission(access, "tickets.view", "tickets.manage"));
  },
  /** has_error_logs_access: any membership with error_logs.view reads every error log. */
  errorLogs(access: Access): SqlFragment {
    return access.isPlatformAdmin ||
      companiesWithPermission(access, "error_logs.view").length > 0
      ? TRUE_SQL
      : FALSE_SQL;
  },
};
