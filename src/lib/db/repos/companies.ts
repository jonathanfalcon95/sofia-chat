import type { Db } from "../types";

export async function insertCompany(
  db: Db,
  values: { name: string; slug: string; guid_company: string | null },
) {
  return db.from("companies").insert(values).select("id").single();
}

export async function updateCompanyById(
  db: Db,
  id: string,
  values: {
    name: string;
    slug: string;
    is_active: boolean;
    guid_company: string | null;
  },
) {
  return db.from("companies").update(values).eq("id", id);
}

export async function listCompanyNames(db: Db) {
  return db.from("companies").select("id, name").order("name");
}

/** One page of companies, newest first, with the exact total. */
export async function listCompaniesPage(
  db: Db,
  filters: {
    status: string;
    searchPattern?: string;
    includeIds?: string[];
    excludeIds?: string[];
    from: number;
    to: number;
  },
) {
  let query = db
    .from("companies")
    .select("id, name, slug, is_active, guid_company", { count: "exact" })
    .order("created_at", { ascending: false });

  if (filters.status === "active") query = query.eq("is_active", true);
  if (filters.status === "inactive") query = query.eq("is_active", false);

  if (filters.searchPattern) {
    const pattern = filters.searchPattern;
    query = query.or(
      `name.ilike."${pattern}",slug.ilike."${pattern}",guid_company.ilike."${pattern}"`,
    );
  }

  if (filters.includeIds) {
    query = query.in("id", filters.includeIds);
  } else if (filters.excludeIds) {
    query = query.not("id", "in", `(${filters.excludeIds.join(",")})`);
  }

  return query.range(filters.from, filters.to);
}
