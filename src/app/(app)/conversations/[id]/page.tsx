import { loadConversationDetailData } from "@/lib/conversations/load-inbox-data";
import { InboxThreadBootstrap } from "@/components/conversations/inbox-thread-context";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await loadConversationDetailData(id, { includeNotes: false });

  return (
    <InboxThreadBootstrap
      conversationId={id}
      initialMessages={detail.initialMessages}
      initialHasMoreMessages={detail.hasMoreMessages}
      initialNotes={detail.initialNotes}
    />
  );
}
