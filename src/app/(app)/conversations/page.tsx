import { createClient } from "@/lib/supabase/server";
import { getAppSession } from "@/lib/rbac/session";
import { listCompanyAgents } from "@/lib/agents";
import { InboxView } from "@/components/conversations/inbox-view";

export default async function ConversationsPage() {
  const session = await getAppSession();
  const supabase = await createClient();

  const [
    { data: conversations },
    agents,
    { data: tags },
    { data: contactTags },
    { data: inboxes },
  ] = await Promise.all([
    supabase
      .from("conversations")
      .select(
        `
        id, company_id, inbox_id, status, last_message_at, last_message_preview,
        window_expires_at, assignee_id, unread_count, contact_id,
        contacts (
          id, name, phone_number,
          contact_tags ( tag_id, tags ( id, name, color, is_kanban_column ) )
        ),
        inboxes ( name, phone_number ),
        conversation_tags ( tag_id, tags ( id, name, color ) )
      `,
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(100),
    listCompanyAgents(),
    supabase
      .from("tags")
      .select("id, name, color, company_id")
      .eq("is_kanban_column", true)
      .order("position"),
    supabase
      .from("tags")
      .select("id, name, color, company_id")
      .eq("is_kanban_column", false)
      .order("name"),
    supabase
      .from("inboxes")
      .select("id, name, phone_number, company_id")
      .eq("is_active", true),
  ]);

  const normalized =
    conversations?.map((c) => {
      const contact = Array.isArray(c.contacts) ? c.contacts[0] : c.contacts;
      const contactTagsNorm = (
        (contact as { contact_tags?: Array<{
          tag_id: string;
          tags: unknown;
        }> } | null)?.contact_tags ?? []
      )
        .map((ct) => ({
          tag_id: ct.tag_id,
          tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
        }))
        .filter(
          (ct) =>
            ct.tags &&
            !(ct.tags as { is_kanban_column?: boolean }).is_kanban_column,
        );

      return {
        ...c,
        contacts: contact
          ? {
              id: (contact as { id: string }).id,
              name: (contact as { name: string | null }).name,
              phone_number: (contact as { phone_number: string }).phone_number,
              contact_tags: contactTagsNorm,
            }
          : null,
        inboxes: Array.isArray(c.inboxes) ? c.inboxes[0] : c.inboxes,
        conversation_tags: (c.conversation_tags ?? []).map((ct) => ({
          tag_id: ct.tag_id,
          tags: Array.isArray(ct.tags) ? ct.tags[0] : ct.tags,
        })),
      };
    }) ?? [];

  return (
    <InboxView
      initialConversations={normalized as never}
      agents={agents}
      tags={tags ?? []}
      contactTags={contactTags ?? []}
      inboxes={inboxes ?? []}
      currentUserId={session?.userId}
    />
  );
}
