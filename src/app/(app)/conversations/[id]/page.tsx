import { loadConversationDetailData } from "@/lib/conversations/load-inbox-data";
import { InboxThreadBootstrap } from "@/components/conversations/inbox-thread-context";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // This page renders above the inbox layout, so a failure is reported to
  // InboxView to show inside the thread pane instead of an error boundary here.
  let detail;
  try {
    detail = await loadConversationDetailData(id, { includeNotes: false });
  } catch (err) {
    console.error("[inbox] conversation detail failed", err);
    return (
      <InboxThreadBootstrap conversationId={id} initialMessages={[]} loadFailed />
    );
  }

  return (
    <InboxThreadBootstrap
      conversationId={id}
      initialMessages={detail.conversation ? detail.initialMessages : []}
      initialHasMoreMessages={
        detail.conversation ? detail.hasMoreMessages : false
      }
      initialNotes={detail.initialNotes}
      conversation={detail.conversation}
      missing={!detail.conversation}
    />
  );
}
