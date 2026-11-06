import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth/current-user";
import { usesSqlServer } from "@/lib/db/backend";
import { inboxesWithPermission, type Access } from "@/lib/db/sqlserver/access";
import { accessOf, userSqlDb } from "@/lib/db/sqlserver/db";
import { touchRealtime, waitForChange } from "@/lib/realtime/changes";
import {
  cursorIsStale,
  eventsAfter,
  eventVisibleTo,
  type RealtimeResponse,
} from "@/lib/realtime/events";

/** Under the roughly 60 s limit App Service puts on a response with no bytes yet. */
const WAIT_MS = 25_000;
/** Permission changes reach a connected client within this long. */
const ACCESS_TTL_MS = 60_000;

const accessCache = new Map<string, { access: Access; at: number }>();

async function cachedAccess(userId: string) {
  const cached = accessCache.get(userId);
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached.access;
  const access = (await accessOf(userSqlDb(userId)))!;
  accessCache.set(userId, { access, at: Date.now() });
  return access;
}

const headers = { "Cache-Control": "no-store" };

/** Long polling: answers with what changed after `after`, or empty once the wait ends. */
export async function GET(request: Request) {
  if (!usesSqlServer()) {
    return NextResponse.json({ mode: "supabase" } satisfies RealtimeResponse, { headers });
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const after = Number(params.get("after") ?? -1);
  const clientEpoch = params.get("epoch");
  const realtime = touchRealtime();

  // A first call, a restarted server or a client too far behind: start over from a reload.
  if (
    after < 0 ||
    clientEpoch !== realtime.epoch ||
    cursorIsStale(realtime.ring, after)
  ) {
    return NextResponse.json(
      {
        mode: "sqlserver",
        epoch: realtime.epoch,
        seq: realtime.seq,
        events: [],
        resync: true,
      } satisfies RealtimeResponse,
      { headers },
    );
  }

  const access = await cachedAccess(userId);
  const visibility = {
    isPlatformAdmin: access.isPlatformAdmin,
    viewableInboxIds: inboxesWithPermission(access, "conversations.view"),
  };

  const deadline = Date.now() + WAIT_MS;
  let cursor = after;
  for (;;) {
    const pending = eventsAfter(realtime.ring, cursor);
    if (pending.length) cursor = pending[pending.length - 1].seq;
    const events = pending.filter((event) => eventVisibleTo(event, visibility));
    const remaining = deadline - Date.now();
    if (events.length || remaining <= 0 || request.signal.aborted) {
      return NextResponse.json(
        {
          mode: "sqlserver",
          epoch: realtime.epoch,
          seq: cursor,
          events,
        } satisfies RealtimeResponse,
        { headers },
      );
    }
    await waitForChange(remaining, request.signal);
  }
}
