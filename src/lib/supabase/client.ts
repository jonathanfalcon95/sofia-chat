import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

export function createClient() {
  if (browserClient) return browserClient;

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  // Keep Realtime JWT in sync so postgres_changes RLS (auth.uid()) works.
  void browserClient.auth.getSession().then(({ data }) => {
    if (data.session?.access_token) {
      browserClient!.realtime.setAuth(data.session.access_token);
    }
  });
  browserClient.auth.onAuthStateChange((_event, session) => {
    browserClient!.realtime.setAuth(session?.access_token ?? null);
  });

  return browserClient;
}
