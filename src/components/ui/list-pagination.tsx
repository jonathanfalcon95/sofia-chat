"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PAGE_SIZE_OPTIONS,
  buildSearchParams,
  totalPages,
} from "@/lib/pagination";
import { cn } from "@/lib/utils";

type ListPaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  /** Current filter params to preserve (without page/pageSize overrides). */
  baseParams?: Record<string, string | undefined | null>;
  className?: string;
};

export function ListPagination({
  page,
  pageSize,
  total,
  baseParams = {},
  className,
}: ListPaginationProps) {
  const pathname = usePathname();
  const pages = totalPages(total, pageSize);
  const safePage = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  function hrefFor(patch: Record<string, string | number | null>) {
    const qs = buildSearchParams(
      {
        ...baseParams,
        page: String(safePage),
        pageSize: String(pageSize),
      },
      patch,
    );
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div
      className={cn(
        "mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--muted)]",
        className,
      )}
    >
      <p>
        {total === 0
          ? "Sin resultados"
          : `Mostrando ${from}–${to} de ${total}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="whitespace-nowrap">Por página</span>
          <select
            className="h-8 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 text-sm text-[var(--ink)]"
            value={pageSize}
            onChange={(e) => {
              const next = Number(e.target.value);
              window.location.assign(hrefFor({ pageSize: next, page: 1 }));
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          {safePage <= 1 ? (
            <Button variant="ghost" size="sm" disabled>
              <ChevronLeft className="h-4 w-4" />
              Anterior
            </Button>
          ) : (
            <Button variant="ghost" size="sm" asChild>
              <Link href={hrefFor({ page: safePage - 1, pageSize })}>
                <ChevronLeft className="h-4 w-4" />
                Anterior
              </Link>
            </Button>
          )}
          <span className="px-2 text-[var(--ink)]">
            Página {safePage} de {pages}
          </span>
          {safePage >= pages ? (
            <Button variant="ghost" size="sm" disabled>
              Siguiente
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" asChild>
              <Link href={hrefFor({ page: safePage + 1, pageSize })}>
                Siguiente
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
