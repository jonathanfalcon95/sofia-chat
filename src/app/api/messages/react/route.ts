import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppReaction } from "@/lib/ycloud/client";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";
import { isWithinCustomerWindow } from "@/lib/utils";
import {
  getAppSession,
  sessionHasPermission,
} from "@/lib/rbac/session";
import { logSystemError } from "@/lib/errors/log-system-error";
import type { MessageReaction } from "@/lib/conversations/types";

export async function POST(request: Request) {
  const supabase = await createClient();
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const conversationId = String(body.conversationId ?? "");
  const messageId = String(body.messageId ?? "");
  const emoji = String(body.emoji ?? "");
  if (!conversationId || !messageId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const { data: conversation, error } = await supabase
    .from("conversations")
    .select(
      `
      id, company_id, window_expires_at, inbox_id,
      inboxes ( phone_number ),
      contacts ( phone_number )
    `,
    )
    .eq("id", conversationId)
    .single();

  if (error || !conversation) {
    return NextResponse.json({ error: "conversation_not_found" }, { status: 404 });
  }

  if (
    !sessionHasPermission(
      session,
      conversation.company_id as string,
      "conversations.reply",
    )
  ) {
    return NextResponse.json(
      { error: "No tienes permiso para reaccionar." },
      { status: 403 },
    );
  }

  if (!isWithinCustomerWindow(conversation.window_expires_at)) {
    return NextResponse.json(
      {
        error:
          "Fuera de la ventana de 24h. El contacto debe escribir primero para reabrir el chat.",
      },
      { status: 400 },
    );
  }

  const inbox = Array.isArray(conversation.inboxes)
    ? conversation.inboxes[0]
    : conversation.inboxes;
  const contact = Array.isArray(conversation.contacts)
    ? conversation.contacts[0]
    : conversation.contacts;

  if (!inbox?.phone_number || !contact?.phone_number) {
    return NextResponse.json({ error: "missing_phones" }, { status: 400 });
  }

  let ycloudApiKey: string;
  try {
    const creds = await getInboxYCloudCredentials(conversation.inbox_id as string);
    ycloudApiKey = creds.apiKey;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ycloud_account_missing" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: target, error: targetError } = await admin
    .from("messages")
    .select("id, wamid, ycloud_message_id, reactions")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();

  if (targetError || !target) {
    return NextResponse.json({ error: "message_not_found" }, { status: 404 });
  }

  const targetWamid =
    target.wamid ||
    (typeof target.ycloud_message_id === "string" &&
    target.ycloud_message_id.startsWith("wamid.")
      ? target.ycloud_message_id
      : null);

  if (!targetWamid) {
    return NextResponse.json(
      {
        error:
          "Este mensaje aún no tiene wamid de WhatsApp. Espera a que se entregue e inténtalo de nuevo.",
      },
      { status: 409 },
    );
  }

  try {
    await sendWhatsAppReaction({
      apiKey: ycloudApiKey,
      from: inbox.phone_number,
      to: contact.phone_number,
      messageId: targetWamid,
      emoji,
    });

    const existing = (Array.isArray(target.reactions)
      ? target.reactions
      : []) as MessageReaction[];
    const withoutOurs = existing.filter((r) => r.direction !== "outbound");
    const next: MessageReaction[] =
      emoji === ""
        ? withoutOurs
        : [
            ...withoutOurs,
            {
              emoji,
              from: inbox.phone_number,
              direction: "outbound",
            },
          ];

    const { data: updated, error: updateError } = await admin
      .from("messages")
      .update({ reactions: next })
      .eq("id", messageId)
      .select("*")
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({ message: updated, reactions: next });
  } catch (err) {
    await logSystemError({
      source: "api.messages.react",
      message: "send reaction failed",
      error: err,
      httpStatus: 502,
      companyId: conversation.company_id as string,
      userId: session.userId,
      errorCode: "reaction_failed",
      context: { conversationId, messageId },
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reaction_failed" },
      { status: 502 },
    );
  }
}
