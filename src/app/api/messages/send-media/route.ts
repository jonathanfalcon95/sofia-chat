import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendWhatsAppMedia,
  uploadWhatsAppMedia,
} from "@/lib/ycloud/client";
import { isWithinCustomerWindow } from "@/lib/utils";
import {
  getAppSession,
  sessionHasPermission,
} from "@/lib/rbac/session";
import { validateOutboundFile, type MediaKind } from "@/lib/media";
import { logSystemError } from "@/lib/errors/log-system-error";

export const runtime = "nodejs";

const KIND_TO_WA: Record<"image" | "audio" | "document", "image" | "audio" | "document"> =
  {
    image: "image",
    audio: "audio",
    document: "document",
  };

function storageMediaUrl(path: string) {
  return `storage:chat-media/${path}`;
}

export async function POST(request: Request) {
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const conversationId = String(form.get("conversationId") ?? "");
  const caption = String(form.get("caption") ?? "").trim();
  const file = form.get("file");

  if (!conversationId || !(file instanceof File)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const validation = validateOutboundFile({
    type: file.type,
    size: file.size,
    name: file.name,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const kind = validation.kind as MediaKind;
  if (kind === "video" || kind === "sticker") {
    return NextResponse.json(
      { error: "Este tipo de archivo no se puede enviar desde el chat aún." },
      { status: 400 },
    );
  }

  // YCloud/WhatsApp reject browser webm; client must send ogg/opus (or mpeg/mp4/aac/amr).
  const mimeRaw = (file.type || "").toLowerCase().split(";")[0]!.trim();
  if (mimeRaw.startsWith("audio/webm") || mimeRaw === "video/webm") {
    return NextResponse.json(
      {
        error:
          "Formato de audio no soportado (webm). Usa la nota de voz del chat (OGG/Opus).",
      },
      { status: 400 },
    );
  }

  const supabase = await createClient();
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
      { error: "No tienes permiso para responder." },
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

  const waType = KIND_TO_WA[kind as "image" | "audio" | "document"];
  const mime = mimeRaw || "application/octet-stream";
  const filename = file.name || `file.${mime.split("/")[1] || "bin"}`;

  try {
    const uploaded = await uploadWhatsAppMedia({
      phoneNumber: inbox.phone_number,
      file,
      filename,
      mimeType: mime,
    });

    const ycloudRes = await sendWhatsAppMedia({
      from: inbox.phone_number,
      to: contact.phone_number,
      type: waType,
      mediaId: uploaded.id,
      caption: caption || undefined,
      filename: waType === "document" ? filename : undefined,
    });

    const ycloudId =
      (ycloudRes.id as string | undefined) ||
      (ycloudRes.messageId as string | undefined) ||
      null;

    const preview =
      caption ||
      (waType === "audio"
        ? "Nota de voz"
        : waType === "image"
          ? "Imagen"
          : filename);

    const admin = createAdminClient();
    const bytes = Buffer.from(await file.arrayBuffer());
    const objectPath = `${conversation.company_id}/${conversationId}/${crypto.randomUUID()}-${filename.replace(/[^\w.\-]+/g, "_")}`;

    let mediaUrl: string | null = null;
    const { error: uploadError } = await admin.storage
      .from("chat-media")
      .upload(objectPath, bytes, {
        contentType: mime,
        upsert: false,
      });
    if (!uploadError) {
      mediaUrl = storageMediaUrl(objectPath);
    } else {
      console.error("chat-media storage upload failed", uploadError);
      await logSystemError({
        source: "api.messages.send-media",
        message: "chat-media storage upload failed",
        error: uploadError,
        level: "warn",
        companyId: conversation.company_id as string,
        userId: session.userId,
        errorCode: "storage_upload_failed",
        context: { conversationId, objectPath, mime },
      });
    }

    const { data: message, error: msgError } = await admin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        company_id: conversation.company_id,
        direction: "outbound",
        type: waType,
        body: preview,
        ycloud_message_id: ycloudId,
        status: "accepted",
        sent_by: session.userId,
        media_mime: mime,
        media_filename: filename,
        media_url: mediaUrl,
        raw_payload: {
          upload: uploaded.raw,
          send: ycloudRes,
          mediaId: uploaded.id,
          storagePath: objectPath,
        },
      })
      .select("*")
      .single();

    if (msgError) {
      await logSystemError({
        source: "api.messages.send-media",
        message: "persist outbound media message failed",
        error: msgError,
        httpStatus: 500,
        companyId: conversation.company_id as string,
        userId: session.userId,
        errorCode: "message_insert_failed",
        context: { conversationId, waType },
      });
      return NextResponse.json({ error: msgError.message }, { status: 500 });
    }

    await admin
      .from("conversations")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: preview.slice(0, 200),
      })
      .eq("id", conversationId);

    return NextResponse.json({ message, ycloud: ycloudRes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "send_media_failed";
    await logSystemError({
      source: "api.messages.send-media",
      message: "send media failed",
      error: err,
      httpStatus: 502,
      companyId: conversation.company_id as string,
      userId: session.userId,
      errorCode: "send_media_failed",
      context: { conversationId, kind },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
