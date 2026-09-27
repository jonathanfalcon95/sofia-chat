import { NextResponse } from "next/server";
import {
  callSmartSalesWhitelist,
  SofiaRequestError,
  whitelistContactName,
} from "@/lib/sofia/client";
import { loadSofiaConversation } from "@/lib/sofia/load-conversation";

export async function POST(request: Request) {
  let body: { conversationId?: string };
  try {
    body = (await request.json()) as { conversationId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const loaded = await loadSofiaConversation(body.conversationId ?? "");
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  try {
    const result = await callSmartSalesWhitelist({
      guidCompany: loaded.ctx.guidCompany,
      phoneNumber: loaded.ctx.customerPhone,
      nameContact: whitelistContactName(
        loaded.ctx.contactName,
        loaded.ctx.customerPhone,
      ),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SofiaRequestError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return NextResponse.json({ success: false, error: err.message }, { status });
    }
    return NextResponse.json(
      { success: false, error: "whitelist_request_failed" },
      { status: 502 },
    );
  }
}
