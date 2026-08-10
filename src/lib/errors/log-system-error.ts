import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

export type ErrorLogLevel = "error" | "warn" | "fatal";

const SENSITIVE_KEY =
  /^(authorization|cookie|password|secret|token|api[_-]?key|service[_-]?role)$/i;
const MAX_STACK = 8000;
const MAX_CONTEXT_DEPTH = 4;
const MAX_STRING = 2000;

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_CONTEXT_DEPTH) return "[truncated]";
  if (typeof value === "string") return truncate(value, MAX_STRING);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncate(value.message, MAX_STRING),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeValue(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type LogSystemErrorInput = {
  source: string;
  message: string;
  error?: unknown;
  level?: ErrorLogLevel;
  httpStatus?: number;
  companyId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  errorCode?: string | null;
  context?: Record<string, unknown>;
};

/** Persist a system incident. Never throws — failures fall back to console. */
export async function logSystemError(input: LogSystemErrorInput) {
  const level = input.level ?? "error";
  const err = input.error;
  const errorName =
    err instanceof Error
      ? err.name
      : err && typeof err === "object" && "name" in err
        ? String((err as { name: unknown }).name)
        : null;
  const errorMessage =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : null;
  const stack =
    err instanceof Error && err.stack
      ? truncate(err.stack, MAX_STACK)
      : null;

  const message = truncate(
    input.message || errorMessage || "unknown_error",
    MAX_STRING,
  );

  const row = {
    level,
    source: input.source,
    message,
    error_name: errorName,
    error_code: input.errorCode ?? null,
    http_status: input.httpStatus ?? null,
    stack,
    context: sanitizeValue(input.context ?? {}) as Record<string, unknown>,
    company_id: input.companyId ?? null,
    user_id: input.userId ?? null,
    request_id: input.requestId ?? null,
  };

  try {
    if (!hasServiceRole()) {
      console.error("[error_logs] missing service role", row);
      return;
    }
    const admin = createAdminClient();
    const { error } = await admin.from("error_logs").insert(row);
    if (error) {
      console.error("[error_logs] insert failed", error, row);
    }
  } catch (persistErr) {
    console.error("[error_logs] persist failed", persistErr, row);
  }
}
