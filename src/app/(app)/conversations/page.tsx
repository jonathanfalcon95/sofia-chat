import { getAppSession } from "@/lib/rbac/session";
import { loadInboxBootstrap } from "@/lib/conversations/load-inbox-data";
import { InboxView } from "@/components/conversations/inbox-view";

export default async function ConversationsPage() {
  const session = await getAppSession();
  const data = await loadInboxBootstrap();

  return (
    <InboxView
      initialConversations={data.conversations}
      agents={data.agents}
      tags={data.tags}
      contactTags={data.contactTags}
      inboxes={data.inboxes}
      currentUserId={session?.userId}
    />
  );
}
