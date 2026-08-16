import { handleYCloudWebhookRequest } from "@/lib/ycloud/webhook-handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleYCloudWebhookRequest(request);
}
