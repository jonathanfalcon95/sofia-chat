import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listWhatsAppTemplates } from "@/lib/ycloud/client";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const data = await listWhatsAppTemplates({ limit: 100 });
    const items = data.items ?? data.data ?? data;
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "templates_failed";
    return NextResponse.json({ error: message, items: [] }, { status: 502 });
  }
}
