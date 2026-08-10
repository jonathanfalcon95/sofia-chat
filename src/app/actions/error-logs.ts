"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  getAppSession,
  sessionHasAnyPermission,
} from "@/lib/rbac/session";

export type ErrorLogStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "ignored";

export async function updateErrorLogStatus(input: {
  id: string;
  status: ErrorLogStatus;
  resolutionNote?: string;
}) {
  const session = await getAppSession();
  if (!session || !sessionHasAnyPermission(session, "error_logs.view")) {
    throw new Error("forbidden");
  }

  const supabase = await createClient();
  const isClosed =
    input.status === "resolved" || input.status === "ignored";

  const { error } = await supabase
    .from("error_logs")
    .update({
      status: input.status,
      resolved_at: isClosed ? new Date().toISOString() : null,
      resolved_by: isClosed ? session.userId : null,
      resolution_note: input.resolutionNote?.trim() || null,
    })
    .eq("id", input.id);

  if (error) throw new Error(error.message);
  revalidatePath("/settings/error-logs");
}
