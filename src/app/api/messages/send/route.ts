import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/ycloud/client";
import { isWithinCustomerWindow } from "@/lib/utils";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
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

  const inbox = Array.isArray(conversation.inboxes)
    ? conversation.inboxes[0]
    : conversation.inboxes;
  const contact = Array.isArray(conversation.contacts)
    ? conversation.contacts[0]
    : conversation.contacts;

  if (!inbox?.phone_number || !contact?.phone_number) {
    return NextResponse.json({ error: "missing_phones" }, { status: 400 });
  }

  try {
    if (mode === "text") {
      if (!isWithinCustomerWindow(conversation.window_expires_at)) {
        return NextResponse.json(
          {
            error:
              "Fuera de la ventana de 24h. Usa una plantilla preaprobada para iniciar o reabrir el chat.",
          },
          { status: 400 },
        );
      }

      const text = String(body.text ?? "").trim();
      if (!text) {
        return NextResponse.json({ error: "empty_text" }, { status: 400 });
      }

      const ycloudRes = await sendWhatsAppText({
        from: inbox.phone_number,
        to: contact.phone_number,
        text,
      });

      const ycloudId =
        (ycloudRes.id as string | undefined) ||
        (ycloudRes.messageId as string | undefined) ||
        null;

      const { data: message, error: msgError } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          company_id: conversation.company_id,
          direction: "outbound",
          type: "text",
          body: text,
          ycloud_message_id: ycloudId,
          status: "accepted",
          sent_by: user.id,
          raw_payload: ycloudRes,
        })
        .select("*")
        .single();

      if (msgError) {
        return NextResponse.json({ error: msgError.message }, { status: 500 });
      }

      await supabase
        .from("conversations")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: text.slice(0, 200),
        })
        .eq("id", conversationId);

      return NextResponse.json({ message, ycloud: ycloudRes });
    }

    const templateName = String(body.templateName ?? "").trim();
    const languageCode = String(body.languageCode ?? "es").trim();
    if (!templateName) {
      return NextResponse.json({ error: "template_required" }, { status: 400 });
    }

    const ycloudRes = await sendWhatsAppTemplate({
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

    const { data: message, error: msgError } = await supabase
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
        sent_by: user.id,
        raw_payload: ycloudRes,
      })
      .select("*")
      .single();

    if (msgError) {
      return NextResponse.json({ error: msgError.message }, { status: 500 });
    }

    await supabase
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
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
