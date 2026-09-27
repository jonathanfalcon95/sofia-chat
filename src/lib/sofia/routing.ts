const DEFAULT_YCLOUD_1 =
  "https://sofia-api-ycloud-dev.thankfulsky-d6ee3cbf.eastus.azurecontainerapps.io";
const DEFAULT_YCLOUD_2 =
  "https://sofia-api-ycloud-global.thankfulsky-d6ee3cbf.eastus.azurecontainerapps.io";

/** YCloud 1 uses the dev Sofia API. YCloud 2 and any other account use the global API. */
export function sofiaApiBaseForAccountName(
  accountName: string | null | undefined,
): string {
  const ycloud1 = trimBase(
    process.env.SOFIA_API_BASE_YCLOUD_1,
    DEFAULT_YCLOUD_1,
  );
  const ycloud2 = trimBase(
    process.env.SOFIA_API_BASE_YCLOUD_2,
    DEFAULT_YCLOUD_2,
  );
  const name = (accountName ?? "").toLowerCase();
  if (!name || (name.includes("1") && !name.includes("2"))) return ycloud1;
  return ycloud2;
}

export function whitelistContactName(
  name: string | null | undefined,
  phoneDigits: string,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const tail = phoneDigits.slice(-6) || "contacto";
  return `User_${tail}`;
}

export function parseSofiaPauseFlags(
  data: Record<string, unknown>,
  action?: string,
): {
  linePaused: boolean | null;
  chatPaused: boolean | null;
} {
  const line = readBool(data.linePaused);
  const chat = readBool(data.chatPaused);
  const paused = readBool(data.paused);
  const kind = action ?? (typeof data.action === "string" ? data.action : "");
  if (kind === "stop-all" || kind === "start-all") {
    return { linePaused: line ?? paused, chatPaused: chat };
  }
  if (kind === "status") {
    return { linePaused: line, chatPaused: chat };
  }
  return { linePaused: line, chatPaused: chat ?? paused };
}

function trimBase(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replace(/\/$/, "");
}

function readBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
