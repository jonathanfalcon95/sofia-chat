"use server";

import { createClient } from "@/lib/supabase/server";
import { getAppSession } from "@/lib/rbac/session";
import {
  loadKanbanColumnCards,
  type KanbanCard,
  type KanbanLoadFilters,
} from "@/lib/kanban/load-kanban-cards";
import { clampPageSize } from "@/lib/pagination";

export async function loadMoreKanbanCards(input: {
  tagId: string;
  offset: number;
  pageSize: number;
  companyId: string;
  inboxId?: string;
  q?: string;
  assignee?: "all" | "mine" | "unassigned";
  includeUntagged?: boolean;
}): Promise<{ cards: KanbanCard[]; hasMore: boolean; nextOffset: number }> {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const filters: KanbanLoadFilters = {
    companyId: input.companyId,
    inboxId: input.inboxId || undefined,
    q: input.q || undefined,
    assignee: input.assignee ?? "all",
    userId: session.userId,
    pageSize: clampPageSize(input.pageSize),
  };

  const supabase = await createClient();
  return loadKanbanColumnCards(supabase, {
    ...filters,
    tagId: input.tagId,
    offset: Math.max(0, input.offset),
    includeUntagged: Boolean(input.includeUntagged),
  });
}
