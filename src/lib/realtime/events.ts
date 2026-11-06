/** A row that changed, shaped like a Supabase `postgres_changes` payload for the same handlers. */
export type RealtimeEvent = {
  seq: number;
  table: "messages" | "conversations";
  eventType: "INSERT" | "UPDATE";
  companyId: string | null;
  inboxId: string | null;
  row: Record<string, unknown> & { id: string };
};

export type RealtimeResponse =
  | { mode: "supabase" }
  | { mode: "sqlserver"; epoch: string; seq: number; events: RealtimeEvent[]; resync?: boolean };

const RING_SIZE = 2000;

/** Newest events; a client too far behind resyncs by reloading. */
export function pushToRing(ring: RealtimeEvent[], event: RealtimeEvent) {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
}

export function eventsAfter(ring: RealtimeEvent[], after: number) {
  return ring.filter((event) => event.seq > after);
}

/** True when a client's cursor points past what the ring still holds. */
export function cursorIsStale(ring: RealtimeEvent[], after: number) {
  return ring.length > 0 && ring[0].seq > after + 1;
}

type Visibility = {
  isPlatformAdmin: boolean;
  /** Inboxes whose conversations the user may read: inbox access plus conversations.view. */
  viewableInboxIds: readonly string[];
};

/** RLS decided this for Supabase Realtime. The messages policy reads conversations too. */
export function eventVisibleTo(event: RealtimeEvent, access: Visibility) {
  if (access.isPlatformAdmin) return true;
  return Boolean(event.inboxId && access.viewableInboxIds.includes(event.inboxId));
}
