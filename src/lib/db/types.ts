import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Handle every repository receives. Today it is a Supabase client: the session client applies
 * RLS and the system client bypasses it. Keeping the type here lets later stages swap it without
 * touching callers.
 */
export type Db = SupabaseClient;

/** Shape every repository function returns, matching what callers already destructure. */
export type DbResult<T> = {
  data: T | null;
  error: { message: string } | null;
};
