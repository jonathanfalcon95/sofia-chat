export type YCloudAccountPublic = {
  id: string;
  name: string;
  isActive: boolean;
  apiKeyLast4: string | null;
  webhookEndpointId: string | null;
  webhookUrl: string;
  hasWebhookSecret: boolean;
};
