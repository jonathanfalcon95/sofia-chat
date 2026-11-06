import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSystemDb } from "@/lib/db/client";
import { findMessageMedia } from "@/lib/db/repos/media";
import { findConversationInbox } from "@/lib/db/repos/messaging";
import { downloadStorageObject } from "@/lib/db/repos/storage";
import { downloadYCloudMedia } from "@/lib/ycloud/client";
import { getInboxYCloudCredentials } from "@/lib/ycloud/accounts";
import { maxBytesForKind, mediaKindFromMime, type MediaKind } from "@/lib/media";
import { mediaContentDisposition } from "@/lib/ycloud/inbound-message-display";

export const runtime = "nodejs";

/** A message's media never changes, and each view otherwise re-downloads it. */
const MEDIA_CACHE_CONTROL = "private, max-age=604800, immutable";

function parseStorageRef(mediaUrl: string): { bucket: string; path: string } | null {
  if (!mediaUrl.startsWith("storage:")) return null;
  const rest = mediaUrl.slice("storage:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await context.params;
  if (!messageId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const asAttachment =
    new URL(request.url).searchParams.get("download") === "1" ||
    new URL(request.url).searchParams.get("attachment") === "1";

  const supabase = await createClient();
  // Verified locally: getUser() added a round trip to Auth for every image.
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims?.sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: message, error } = await findMessageMedia(supabase, messageId);

  if (error || !message?.media_url) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const mimeHint =
    message.media_mime ||
    (message.type === "image"
      ? "image/jpeg"
      : message.type === "audio"
        ? "audio/ogg"
        : message.type === "video"
          ? "video/mp4"
          : "application/octet-stream");
  const kind =
    mediaKindFromMime(mimeHint) ||
    (["image", "audio", "video", "document", "sticker"].includes(message.type)
      ? (message.type as MediaKind)
      : "document");
  const maxBytes = maxBytesForKind(kind, true);
  const disposition = mediaContentDisposition(
    message.media_filename,
    message.type,
    asAttachment,
  );

  try {
    const storageRef = parseStorageRef(message.media_url);
    if (storageRef) {
      const admin = getSystemDb();
      const { data: file, error: dlError } = await downloadStorageObject(
        admin,
        storageRef.bucket,
        storageRef.path,
      );
      if (dlError || !file) {
        return NextResponse.json(
          { error: dlError?.message || "storage_missing" },
          { status: 404 },
        );
      }
      if (file.size > maxBytes) {
        return NextResponse.json({ error: "file_too_large" }, { status: 413 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      return new NextResponse(buf, {
        status: 200,
        headers: {
          "Content-Type": message.media_mime || file.type || mimeHint,
          "Cache-Control": MEDIA_CACHE_CONTROL,
          "Content-Length": String(buf.byteLength),
          "Content-Disposition": disposition,
        },
      });
    }

    const { data: conversation, error: convError } = await findConversationInbox(
      supabase,
      message.conversation_id,
    );
    if (convError || !conversation?.inbox_id) {
      return NextResponse.json({ error: "inbox_not_found" }, { status: 404 });
    }
    const creds = await getInboxYCloudCredentials(conversation.inbox_id as string);
    const upstream = await downloadYCloudMedia(message.media_url, creds.apiKey);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `ycloud_${upstream.status}` },
        { status: 502 },
      );
    }

    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > maxBytes) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }

    const contentType =
      upstream.headers.get("content-type") ||
      message.media_mime ||
      "application/octet-stream";

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": MEDIA_CACHE_CONTROL,
        "Content-Disposition": disposition,
        ...(contentLength
          ? { "Content-Length": String(contentLength) }
          : {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "proxy_failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
