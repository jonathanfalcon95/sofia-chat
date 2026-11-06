import { handleYCloudWebhookRequest } from "@/lib/ycloud/webhook-handler";

export const runtime = "nodejs";
// Room for the after() text enrichment, which calls YCloud.
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleYCloudWebhookRequest(request);
}
