"use client";

import { memo } from "react";
import { Avatar } from "@/components/ui/avatar";
import { assigneeColor } from "@/lib/conversations/assignee-color";
import { formatChatListTime } from "@/lib/conversations/day-grouping";
import type { ConversationRow } from "@/lib/conversations/types";
import { cn } from "@/lib/utils";
import { sanitizeMessageBody } from "@/lib/ycloud/inbound-message-display";

export const ConversationListItem = memo(function ConversationListItem({
  conversation: c,
  isActive,
  assigneeName,
  showInboxName,
  onOpen,
  onIntent,
  onIntentEnd,
}: {
  conversation: ConversationRow;
  isActive: boolean;
  assigneeName: string | null;
  showInboxName: boolean;
  onOpen: (id: string) => void;
  onIntent: (id: string) => void;
  onIntentEnd: () => void;
}) {
  const contact = c.contacts;
  const displayName = contact?.name || contact?.phone_number;
  const unread = c.unread_count > 0;
  const tags = [
    ...(c.conversation_tags ?? []).map((t) => t.tags),
    ...(contact?.contact_tags ?? []).map((t) => t.tags),
  ].filter((t) => t !== null);
  const [firstTag, ...otherTags] = tags;
  const hasMeta =
    Boolean(c.assignee_id) || tags.length > 0 || showInboxName;

  return (
    <button
      type="button"
      onClick={() => onOpen(c.id)}
      onMouseEnter={() => onIntent(c.id)}
      onMouseLeave={onIntentEnd}
      onFocus={() => onIntent(c.id)}
      onBlur={onIntentEnd}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "chat-row flex w-full items-center gap-3 pl-3 text-left transition",
        isActive ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-3)]",
      )}
    >
      <Avatar name={contact?.name} seed={contact?.id ?? c.id} />
      <div className="min-w-0 flex-1 border-b border-[var(--line)] py-2.5 pr-3">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-[15px] text-[var(--ink)]",
              unread && "font-semibold",
            )}
          >
            {displayName}
          </span>
          <span
            suppressHydrationWarning
            className={cn(
              "shrink-0 text-[11px]",
              unread
                ? "font-semibold text-[var(--accent)]"
                : "text-[var(--muted)]",
            )}
          >
            {c.last_message_at
              ? formatChatListTime(new Date(c.last_message_at))
              : ""}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              unread ? "text-[var(--ink)]" : "text-[var(--muted)]",
            )}
          >
            {c.last_message_preview
              ? sanitizeMessageBody(c.last_message_preview)
              : "Sin mensajes"}
          </p>
          {unread ? (
            <span className="chat-unread-badge flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none">
              {c.unread_count > 99 ? "99+" : c.unread_count}
            </span>
          ) : null}
        </div>
        {hasMeta ? (
          <div className="mt-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-[var(--muted)]">
            {c.assignee_id ? (
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: assigneeColor(c.assignee_id) }}
                />
                <span className="truncate">{assigneeName ?? "Agente"}</span>
              </span>
            ) : null}
            {firstTag ? (
              <span
                className="shrink-0 rounded-full px-1.5 py-px font-medium"
                style={{
                  background: `${firstTag.color}22`,
                  color: firstTag.color,
                }}
              >
                {firstTag.name}
              </span>
            ) : null}
            {otherTags.length > 0 ? (
              <span className="shrink-0">+{otherTags.length}</span>
            ) : null}
            {showInboxName && c.inboxes?.name ? (
              <span className="ml-auto truncate">{c.inboxes.name}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </button>
  );
});
