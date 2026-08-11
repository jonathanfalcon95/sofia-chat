"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { setConversationTag } from "@/app/actions/conversations";
import { loadMoreKanbanCards } from "@/app/actions/kanban";
import { Button } from "@/components/ui/button";
import type { KanbanCard } from "@/lib/kanban/load-kanban-cards";

type Tag = { id: string; name: string; color: string; position: number };

export function KanbanBoard({
  tags,
  cards,
  hasMoreByTag,
  offsetByTag,
  pageSize,
  filters,
}: {
  tags: Tag[];
  cards: KanbanCard[];
  hasMoreByTag: Record<string, boolean>;
  offsetByTag: Record<string, number>;
  pageSize: number;
  filters: {
    companyId: string;
    inboxId?: string;
    q?: string;
    assignee?: "all" | "mine" | "unassigned";
  };
}) {
  const [items, setItems] = useState(cards);
  const [hasMore, setHasMore] = useState(hasMoreByTag);
  const [offsets, setOffsets] = useState(offsetByTag);
  const [pending, startTransition] = useTransition();
  const [loadingTag, setLoadingTag] = useState<string | null>(null);

  useEffect(() => {
    setItems(cards);
    setHasMore(hasMoreByTag);
    setOffsets(offsetByTag);
  }, [cards, hasMoreByTag, offsetByTag]);

  const columns = useMemo(() => {
    return [...tags]
      .sort((a, b) => a.position - b.position)
      .map((tag) => ({
        tag,
        cards: items.filter((c) => c.tagId === tag.id),
      }));
  }, [tags, items]);

  function onDrop(tagId: string, conversationId: string) {
    const previousTagId =
      items.find((c) => c.id === conversationId)?.tagId ?? null;
    setItems((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, tagId } : c)),
    );
    startTransition(async () => {
      try {
        await setConversationTag(conversationId, tagId);
        toast.success("Contacto movido en el kanban");
      } catch (err) {
        setItems((prev) =>
          prev.map((c) =>
            c.id === conversationId ? { ...c, tagId: previousTagId } : c,
          ),
        );
        toast.error(err instanceof Error ? err.message : "Error");
      }
    });
  }

  function onLoadMore(tagId: string, isFirstColumn: boolean) {
    if (!filters.companyId || loadingTag) return;
    setLoadingTag(tagId);
    startTransition(async () => {
      try {
        const result = await loadMoreKanbanCards({
          tagId,
          offset: offsets[tagId] ?? 0,
          pageSize,
          companyId: filters.companyId,
          inboxId: filters.inboxId,
          q: filters.q,
          assignee: filters.assignee,
          includeUntagged: isFirstColumn,
        });
        setItems((prev) => {
          const seen = new Set(prev.map((c) => c.contactId));
          const next = [...prev];
          for (const card of result.cards) {
            if (seen.has(card.contactId)) continue;
            seen.add(card.contactId);
            next.push(card);
          }
          return next;
        });
        setHasMore((prev) => ({ ...prev, [tagId]: result.hasMore }));
        setOffsets((prev) => ({ ...prev, [tagId]: result.nextOffset }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Error al cargar");
      } finally {
        setLoadingTag(null);
      }
    });
  }

  return (
    <div
      className={`flex gap-3 overflow-x-auto pb-3 ${pending ? "opacity-80" : ""}`}
    >
      {columns.map(({ tag, cards: colCards }, index) => (
        <div
          key={tag.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const conversationId = e.dataTransfer.getData("text/plain");
            if (conversationId) onDrop(tag.id, conversationId);
          }}
          className="min-w-[280px] max-w-[300px] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3"
        >
          <div className="mb-3 flex items-center gap-2 border-b border-[var(--line)] pb-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: tag.color }}
            />
            <strong className="text-sm">{tag.name}</strong>
            <span className="ml-auto text-xs text-[var(--muted)]">
              {colCards.length}
            </span>
          </div>
          <div className="grid min-h-[120px] gap-2">
            {colCards.map((card) => (
              <div
                key={card.contactId}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData("text/plain", card.id)
                }
                className="cursor-grab rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-3 active:cursor-grabbing"
              >
                <div className="text-sm font-semibold leading-snug">
                  {card.contactName}
                </div>
                <div className="mt-0.5 text-xs text-[var(--muted)]">
                  {card.phone}
                </div>
                {card.inboxName ? (
                  <div className="mt-1.5 inline-flex rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                    {card.inboxName}
                  </div>
                ) : null}
                <div className="mt-2 line-clamp-2 text-sm text-[var(--muted)]">
                  {card.preview || "Sin mensajes"}
                </div>
                <div className="mt-3">
                  <Link
                    href={`/conversations/${card.id}`}
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-xs font-semibold hover:bg-[var(--accent-soft)]"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    Abrir chat
                  </Link>
                </div>
              </div>
            ))}
          </div>
          {hasMore[tag.id] ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3 w-full"
              loading={loadingTag === tag.id}
              onClick={() => onLoadMore(tag.id, index === 0)}
            >
              Cargar más
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
