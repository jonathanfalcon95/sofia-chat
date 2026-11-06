"use server";

import { revalidatePath } from "next/cache";
import { getUserDb } from "@/lib/db/client";
import { updateErrorLog } from "@/lib/db/repos/errors";
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

  const supabase = await getUserDb();
  const isClosed =
    input.status === "resolved" || input.status === "ignored";

  const { error } = await updateErrorLog(supabase, input.id, {
    status: input.status,
    resolved_at: isClosed ? new Date().toISOString() : null,
    resolved_by: isClosed ? session.userId : null,
    resolution_note: input.resolutionNote?.trim() || null,
  });

  if (error) throw new Error(error.message);
  revalidatePath("/settings/error-logs");
}
