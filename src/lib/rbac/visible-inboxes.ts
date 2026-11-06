type VisibilitySession = {
  isPlatformAdmin: boolean;
  memberships: Array<{
    companyId: string;
    permissions: string[];
    inboxIds: string[];
  }>;
};

export type InboxVisibility = {
  /** Companies whose inboxes the user sees in full (inboxes.manage). */
  managedCompanyIds: string[];
  /** Inboxes assigned one by one in the remaining companies. */
  assignedInboxIds: string[];
  /** Companies where the user may read conversations (conversations.view). */
  conversationCompanyIds: string[];
};

/**
 * The rules of has_inbox_access and conversations_select, for service-role
 * queries that skip RLS. Null means platform admin, who sees everything.
 */
export function inboxVisibility(
  session: VisibilitySession,
): InboxVisibility | null {
  if (session.isPlatformAdmin) return null;
  const visibility: InboxVisibility = {
    managedCompanyIds: [],
    assignedInboxIds: [],
    conversationCompanyIds: [],
  };
  for (const m of session.memberships) {
    if (m.permissions.includes("inboxes.manage")) {
      visibility.managedCompanyIds.push(m.companyId);
    } else {
      visibility.assignedInboxIds.push(...m.inboxIds);
    }
    if (m.permissions.includes("conversations.view")) {
      visibility.conversationCompanyIds.push(m.companyId);
    }
  }
  return visibility;
}

/** PostgREST `or` filter for the inboxes table; null when nothing is visible. */
export function visibleInboxesFilter(visibility: InboxVisibility): string | null {
  const parts: string[] = [];
  if (visibility.managedCompanyIds.length > 0) {
    parts.push(`company_id.in.(${visibility.managedCompanyIds.join(",")})`);
  }
  if (visibility.assignedInboxIds.length > 0) {
    parts.push(`id.in.(${visibility.assignedInboxIds.join(",")})`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}
