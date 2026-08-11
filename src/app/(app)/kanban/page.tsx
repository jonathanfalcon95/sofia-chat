import { createClient } from "@/lib/supabase/server";
import { getAppSession } from "@/lib/rbac/session";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadAllKanbanColumns } from "@/lib/kanban/load-kanban-cards";
import {
  PAGE_SIZE_OPTIONS,
  clampPageSize,
  firstSearchParam,
} from "@/lib/pagination";

export default async function KanbanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getAppSession();
  const sp = await searchParams;
  const supabase = await createClient();

  const q = (firstSearchParam(sp.q) ?? "").trim();
  const assigneeRaw = firstSearchParam(sp.assignee) ?? "all";
  const assignee =
    assigneeRaw === "mine" || assigneeRaw === "unassigned"
      ? assigneeRaw
      : "all";
  const pageSize = clampPageSize(
    firstSearchParam(sp.pageSize) ?? undefined,
  );
  const inboxId = firstSearchParam(sp.inboxId) ?? "";

  const { data: companies } = await supabase
    .from("companies")
    .select("id, name")
    .order("name");
  const companyId =
    firstSearchParam(sp.companyId) || companies?.[0]?.id || "";

  let inboxQuery = supabase.from("inboxes").select("id, name, company_id");
  if (companyId) inboxQuery = inboxQuery.eq("company_id", companyId);
  const { data: inboxes } = await inboxQuery;

  let tagsQuery = supabase
    .from("tags")
    .select("id, name, color, position, company_id")
    .eq("is_kanban_column", true)
    .order("position");
  if (companyId) tagsQuery = tagsQuery.eq("company_id", companyId);
  const { data: tags } = await tagsQuery;

  const { cards, hasMoreByTag, offsetByTag } =
    companyId && (tags?.length ?? 0) > 0
      ? await loadAllKanbanColumns(
          supabase,
          {
            companyId,
            inboxId: inboxId || undefined,
            q: q || undefined,
            assignee,
            userId: session?.userId,
            pageSize,
          },
          tags ?? [],
        )
      : { cards: [], hasMoreByTag: {}, offsetByTag: {} };

  return (
    <div>
      <PageHeader
        title="Kanban de ventas"
        description="Una tarjeta por contacto. Arrastra entre columnas o abre el chat."
        actions={
          <form className="flex flex-wrap items-end gap-2">
            <select
              name="companyId"
              defaultValue={companyId}
              className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
            >
              {(companies ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              name="inboxId"
              defaultValue={inboxId}
              className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
            >
              <option value="">Todos los inboxes</option>
              {(inboxes ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <select
              name="assignee"
              defaultValue={assignee}
              className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
            >
              <option value="all">Todos los asignados</option>
              <option value="mine">Míos</option>
              <option value="unassigned">Sin asignar</option>
            </select>
            <select
              name="pageSize"
              defaultValue={String(pageSize)}
              className="h-10 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} / columna
                </option>
              ))}
            </select>
            <Input
              name="q"
              defaultValue={q}
              placeholder="Buscar contacto…"
              className="h-10 w-[180px]"
            />
            <Button type="submit" variant="secondary">
              Filtrar
            </Button>
          </form>
        }
      />
      <KanbanBoard
        tags={tags ?? []}
        cards={cards}
        hasMoreByTag={hasMoreByTag}
        offsetByTag={offsetByTag}
        pageSize={pageSize}
        filters={{
          companyId,
          inboxId: inboxId || undefined,
          q: q || undefined,
          assignee,
        }}
      />
    </div>
  );
}
