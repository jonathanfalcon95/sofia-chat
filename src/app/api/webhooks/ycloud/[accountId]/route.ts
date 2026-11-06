import { handleYCloudWebhookRequest } from "@/lib/ycloud/webhook-handler";

export const runtime = "nodejs";
// Room for the after() text enrichment, which calls YCloud.
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await context.params;
  if (!accountId) {
    return Response.json({ error: "missing_account" }, { status: 400 });
  }
  return handleYCloudWebhookRequest(request, accountId);
}
