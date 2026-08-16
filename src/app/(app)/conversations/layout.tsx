import { getAppSession } from "@/lib/rbac/session";
import { loadInboxListData } from "@/lib/conversations/load-inbox-data";
import { InboxView } from "@/components/conversations/inbox-view";

export default async function ConversationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, data] = await Promise.all([
    getAppSession(),
    loadInboxListData(),
  ]);

  return (
    <InboxView
      initialConversations={data.conversations}
      initialHasMoreConversations={data.hasMoreConversations}
      agents={data.agents}
      tags={data.tags}
      contactTags={data.contactTags}
      currentUserId={session?.userId}
    >
      {children}
    </InboxView>
  );
}
