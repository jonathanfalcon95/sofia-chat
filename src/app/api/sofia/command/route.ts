import { NextResponse } from "next/server";
import {
  callSofiaCommand,
  SofiaRequestError,
  type SofiaCommandAction,
} from "@/lib/sofia/client";
import { loadSofiaConversation } from "@/lib/sofia/load-conversation";

const ACTIONS = new Set<SofiaCommandAction>([
  "stop",
  "start",
  "stop-all",
  "start-all",
]);

export async function POST(request: Request) {
  let body: { conversationId?: string; action?: string };
  try {
    body = (await request.json()) as { conversationId?: string; action?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action as SofiaCommandAction;
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const loaded = await loadSofiaConversation(body.conversationId ?? "");
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  try {
    const result = await callSofiaCommand({
      accountName: loaded.ctx.accountName,
      action,
      guidCompany: loaded.ctx.guidCompany,
      botPhone: loaded.ctx.botPhone,
      customerPhone:
        action === "stop" || action === "start"
          ? loaded.ctx.customerPhone
          : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return sofiaErrorResponse(err);
  }
}

function sofiaErrorResponse(err: unknown) {
  if (err instanceof SofiaRequestError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return NextResponse.json({ success: false, error: err.message }, { status });
  }
  return NextResponse.json(
    { success: false, error: "sofia_request_failed" },
    { status: 502 },
  );
}
