export const DEFAULT_PAGE_SIZE = 15;
export const MAX_PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = [15, 25, 50, 100] as const;

export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

export type ParsedPageParams = {
  page: number;
  pageSize: number;
  from: number;
  to: number;
};

export function clampPageSize(n: unknown): number {
  const raw = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(raw));
}

export function parsePageParams(
  sp: Record<string, string | string[] | undefined> | {
    page?: string;
    pageSize?: string;
    [key: string]: string | string[] | undefined;
  },
): ParsedPageParams {
  const pageRaw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const sizeRaw = Array.isArray(sp.pageSize) ? sp.pageSize[0] : sp.pageSize;
  const page = Math.max(1, Math.floor(Number(pageRaw) || 1));
  const pageSize = clampPageSize(sizeRaw ?? DEFAULT_PAGE_SIZE);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

export function totalPages(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Build a query string preserving existing params; omits empty values. */
export function buildSearchParams(
  current: URLSearchParams | Record<string, string | undefined | null>,
  patch: Record<string, string | number | undefined | null>,
): string {
  const params =
    current instanceof URLSearchParams
      ? new URLSearchParams(current.toString())
      : new URLSearchParams(
          Object.entries(current)
            .filter(([, v]) => v != null && String(v).length > 0)
            .map(([k, v]) => [k, String(v)]),
        );

  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") {
      params.delete(key);
    } else {
      params.set(key, String(value));
    }
  }

  return params.toString();
}

export function firstSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Escape a value for use inside a PostgREST `.or()` / filter string. */
export function escapeIlike(value: string): string {
  return value.replace(/[%_,."'\\()]/g, "").trim();
}

export function ilikePattern(value: string): string {
  return `%${escapeIlike(value)}%`;
}
