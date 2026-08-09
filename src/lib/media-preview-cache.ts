/** Session-only blob previews for outbound media (survive realtime replace). */
const previewByMessageId = new Map<string, string>();

export function rememberMediaPreview(messageId: string, url: string) {
  if (!messageId || !url) return;
  previewByMessageId.set(messageId, url);
}

export function takeMediaPreview(messageId: string): string | null {
  return previewByMessageId.get(messageId) ?? null;
}

export function forgetMediaPreview(messageId: string) {
  const url = previewByMessageId.get(messageId);
  if (url?.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
  previewByMessageId.delete(messageId);
}
