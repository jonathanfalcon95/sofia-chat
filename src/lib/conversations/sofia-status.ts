const STORAGE_KEY = "sofia:stopped_all";

export function readSofiaStoppedAll(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSofiaStoppedAll(stopped: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (stopped) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Latest global command in a message list wins; otherwise keep `fallback`. */
export function inferSofiaStoppedAllFromMessages(
  messages: Array<{ body: string | null }>,
  fallback = false,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const body = messages[i]?.body?.trim();
    if (body === "/stopsofia_all") return true;
    if (body === "/startsofia_all") return false;
  }
  return fallback;
}

export function syncSofiaStoppedAllFromCommand(command: string) {
  const cmd = command.trim();
  if (cmd === "/stopsofia_all") {
    writeSofiaStoppedAll(true);
    return true;
  }
  if (cmd === "/startsofia_all") {
    writeSofiaStoppedAll(false);
    return false;
  }
  return null;
}
