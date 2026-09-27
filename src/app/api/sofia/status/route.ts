import { NextResponse } from "next/server";
import { callSofiaStatus, SofiaRequestError } from "@/lib/sofia/client";
import { loadSofiaConversation } from "@/lib/sofia/load-conversation";

export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId") ?? "";
  const loaded = await loadSofiaConversation(conversationId);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  try {
    const result = await callSofiaStatus({
      accountName: loaded.ctx.accountName,
      guidCompany: loaded.ctx.guidCompany,
      botPhone: loaded.ctx.botPhone,
      customerPhone: loaded.ctx.customerPhone,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SofiaRequestError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return NextResponse.json({ success: false, error: err.message }, { status });
    }
    return NextResponse.json(
      { success: false, error: "sofia_request_failed" },
      { status: 502 },
    );
  }
}
