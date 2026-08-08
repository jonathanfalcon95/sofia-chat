export type InboxNotifyDetail = {
  type: "assignment" | "message";
  conversationId: string;
  messageId?: string;
  body?: string | null;
  createdAt?: string;
  assigneeId?: string | null;
  previousAssigneeId?: string | null;
};

declare global {
  interface WindowEventMap {
    "sofia:notify": CustomEvent<InboxNotifyDetail>;
  }
}

export function emitSofiaNotify(detail: InboxNotifyDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("sofia:notify", { detail }));
}
