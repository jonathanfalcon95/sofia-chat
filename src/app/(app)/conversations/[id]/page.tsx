import { getAppSession } from "@/lib/rbac/session";
import { loadInboxBootstrap } from "@/lib/conversations/load-inbox-data";
import { InboxView } from "@/components/conversations/inbox-view";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getAppSession();
  const data = await loadInboxBootstrap(id);

  return (
    <InboxView
      initialConversations={data.conversations}
      agents={data.agents}
      tags={data.tags}
      contactTags={data.contactTags}
      inboxes={data.inboxes}
      selectedId={id}
      currentUserId={session?.userId}
      initialMessages={data.initialMessages}
      initialNotes={data.initialNotes}
      initialHasMoreMessages={data.hasMoreMessages}
    />
  );
}
