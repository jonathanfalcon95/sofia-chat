import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { downloadYCloudMedia } from "@/lib/ycloud/client";
import { maxBytesForKind, mediaKindFromMime, type MediaKind } from "@/lib/media";

export const runtime = "nodejs";

function parseStorageRef(mediaUrl: string): { bucket: string; path: string } | null {
  if (!mediaUrl.startsWith("storage:")) return null;
  const rest = mediaUrl.slice("storage:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await context.params;
  if (!messageId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: message, error } = await supabase
    .from("messages")
    .select("id, media_url, media_mime, type, body, media_filename")
    .eq("id", messageId)
    .maybeSingle();

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

  try {
    const storageRef = parseStorageRef(message.media_url);
    if (storageRef) {
      const admin = createAdminClient();
      const { data: file, error: dlError } = await admin.storage
        .from(storageRef.bucket)
        .download(storageRef.path);
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
          "Cache-Control": "private, max-age=300",
          "Content-Length": String(buf.byteLength),
          ...(message.media_filename
            ? {
                "Content-Disposition": `inline; filename="${message.media_filename.replace(/"/g, "")}"`,
              }
            : {}),
        },
      });
    }

    const upstream = await downloadYCloudMedia(message.media_url);
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
        "Cache-Control": "private, max-age=300",
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
