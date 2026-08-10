import { getAppSession } from "@/lib/rbac/session";
import {
  loadConversationDetailData,
  loadInboxListData,
} from "@/lib/conversations/load-inbox-data";
import { InboxView } from "@/components/conversations/inbox-view";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [session, listData, detailData] = await Promise.all([
    getAppSession(),
    loadInboxListData(),
    loadConversationDetailData(id, { includeNotes: false }),
  ]);

  return (
    <InboxView
      initialConversations={listData.conversations}
      agents={listData.agents}
      tags={listData.tags}
      contactTags={listData.contactTags}
      selectedId={id}
      currentUserId={session?.userId}
      initialMessages={detailData.initialMessages}
      initialNotes={detailData.initialNotes}
      initialHasMoreMessages={detailData.hasMoreMessages}
    />
  );
}
