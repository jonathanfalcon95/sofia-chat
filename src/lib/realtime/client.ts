import type { RealtimeEvent, RealtimeResponse } from "./events";

export type RealtimeSignal = RealtimeEvent | { resync: true };
type Listener = (signal: RealtimeSignal) => void;

const RETRY_MS = 3_000;

let modePromise: Promise<"supabase" | "sqlserver"> | null = null;
const listeners = new Set<Listener>();
let running = false;

async function poll(after: number, epoch: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ after: String(after), epoch });
  const res = await fetch(`/api/realtime?${params}`, {
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!res.ok) throw new Error(`realtime ${res.status}`);
  return (await res.json()) as RealtimeResponse;
}

/** The server decides, so returning to Supabase needs no new browser build. */
export function realtimeMode() {
  modePromise ??= poll(-1, "")
    .then((body) => body.mode)
    .catch(() => {
      modePromise = null;
      return "supabase" as const;
    });
  return modePromise;
}

async function loop() {
  let after = -1;
  let epoch = "";
  while (listeners.size > 0) {
    try {
      const body = await poll(after, epoch);
      if (body.mode !== "sqlserver") return;
      after = body.seq;
      if (body.resync && epoch) {
        for (const listener of listeners) listener({ resync: true });
      }
      epoch = body.epoch;
      for (const event of body.events) {
        for (const listener of listeners) listener(event);
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

/** All subscribers in a tab share one request. */
export function subscribeRealtime(listener: Listener) {
  listeners.add(listener);
  if (!running) {
    running = true;
    void loop().finally(() => {
      running = false;
    });
  }
  return () => {
    listeners.delete(listener);
  };
}
