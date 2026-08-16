import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/ycloud/client";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";
import { isWithinCustomerWindow } from "@/lib/utils";
import {
  getAppSession,
  sessionHasPermission,
} from "@/lib/rbac/session";
import { logSystemError } from "@/lib/errors/log-system-error";

export async function POST(request: Request) {
  const supabase = await createClient();
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const conversationId = body.conversationId as string;
  const mode = (body.mode as "text" | "template") ?? "text";

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
      {
        error:
          "No tienes permiso para responder en esta conversación (conversations.reply).",
      },
      { status: 403 },
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

  // Persist with service role after authz checks so a successful YCloud send
  // cannot be orphaned by messages INSERT RLS.
  const admin = createAdminClient();

  try {
    if (mode === "text") {
      if (!isWithinCustomerWindow(conversation.window_expires_at)) {
        return NextResponse.json(
          {
            error:
              "Fuera de la ventana de 24h. El contacto debe escribir primero para reabrir el chat.",
          },
          { status: 400 },
        );
      }

      const text = String(body.text ?? "").trim();
      if (!text) {
        return NextResponse.json({ error: "empty_text" }, { status: 400 });
      }

      const replyToWamid = String(body.replyToWamid ?? "").trim() || undefined;

      const ycloudRes = await sendWhatsAppText({
        apiKey: ycloudApiKey,
        from: inbox.phone_number,
        to: contact.phone_number,
        text,
        replyToWamid,
      });

      const ycloudId =
        (ycloudRes.id as string | undefined) ||
        (ycloudRes.messageId as string | undefined) ||
        null;
      const wamid =
        (ycloudRes.wamid as string | undefined) ||
        (typeof ycloudId === "string" && ycloudId.startsWith("wamid.")
          ? ycloudId
          : null);

      const { data: message, error: msgError } = await admin
        .from("messages")
        .insert({
          conversation_id: conversationId,
          company_id: conversation.company_id,
          direction: "outbound",
          type: "text",
          body: text,
          ycloud_message_id: ycloudId,
          wamid,
          reply_to_wamid: replyToWamid ?? null,
          status: "accepted",
          sent_by: session.userId,
          raw_payload: ycloudRes,
        })
        .select("*")
        .single();

      if (msgError) {
        await logSystemError({
          source: "api.messages.send",
          message: "persist outbound text message failed",
          error: msgError,
          httpStatus: 500,
          companyId: conversation.company_id as string,
          userId: session.userId,
          errorCode: "message_insert_failed",
          context: { conversationId, mode: "text" },
        });
        return NextResponse.json({ error: msgError.message }, { status: 500 });
      }

      await admin
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 200),
        })
        .eq("id", conversationId);

      return NextResponse.json({ message, ycloud: ycloudRes });
    }

    if (!sessionHasPermission(session, conversation.company_id as string, "templates.send")) {
      return NextResponse.json(
        {
          error:
            "No tienes permiso para enviar plantillas (templates.send).",
        },
        { status: 403 },
      );
    }

    const templateName = String(body.templateName ?? "").trim();
    const languageCode = String(body.languageCode ?? "es").trim();
    if (!templateName) {
      return NextResponse.json({ error: "template_required" }, { status: 400 });
    }

    const ycloudRes = await sendWhatsAppTemplate({
      apiKey: ycloudApiKey,
      from: inbox.phone_number,
      to: contact.phone_number,
      template: {
        name: templateName,
        language: { code: languageCode },
        components: body.components ?? [],
      },
    });

    const ycloudId =
      (ycloudRes.id as string | undefined) ||
      (ycloudRes.messageId as string | undefined) ||
      null;

    const { data: message, error: msgError } = await admin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        company_id: conversation.company_id,
        direction: "outbound",
        type: "template",
        body: `Plantilla: ${templateName}`,
        template_name: templateName,
        template_language: languageCode,
        template_components: body.components ?? [],
        ycloud_message_id: ycloudId,
        status: "accepted",
        sent_by: session.userId,
        raw_payload: ycloudRes,
      })
      .select("*")
      .single();

    if (msgError) {
      await logSystemError({
        source: "api.messages.send",
        message: "persist outbound template message failed",
        error: msgError,
        httpStatus: 500,
        companyId: conversation.company_id as string,
        userId: session.userId,
        errorCode: "message_insert_failed",
        context: { conversationId, mode: "template", templateName },
      });
      return NextResponse.json({ error: msgError.message }, { status: 500 });
    }

    await admin
      .from("conversations")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: `Plantilla: ${templateName}`,
        status: "open",
      })
      .eq("id", conversationId);

    return NextResponse.json({ message, ycloud: ycloudRes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "send_failed";
    await logSystemError({
      source: "api.messages.send",
      message: "send message failed",
      error: err,
      httpStatus: 502,
      companyId: conversation.company_id as string,
      userId: session.userId,
      errorCode: "send_failed",
      context: { conversationId, mode },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
