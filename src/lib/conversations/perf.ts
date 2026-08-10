type MetricPayload = Record<string, unknown>;

function roundedDuration(value: number) {
  return Number(value.toFixed(1));
}

export function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function reportServerConversationMetric(
  metric: string,
  payload: MetricPayload = {},
) {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.LOG_CHAT_PERF !== "1"
  ) {
    return;
  }
  console.info("[perf][conversation][server]", metric, payload);
}

export function reportServerDuration(
  metric: string,
  startedAtMs: number,
  payload: MetricPayload = {},
) {
  reportServerConversationMetric(metric, {
    ...payload,
    durationMs: roundedDuration(nowMs() - startedAtMs),
  });
}

export function reportClientConversationMetric(
  metric: string,
  payload: MetricPayload = {},
) {
  if (typeof window === "undefined") return;
  const detail = { metric, ...payload };
  window.dispatchEvent(new CustomEvent("chatbase:conversation-perf", { detail }));
  if (process.env.NODE_ENV !== "production") {
    console.info("[perf][conversation][client]", metric, payload);
  }
}

export function durationSince(startedAtMs: number) {
  return roundedDuration(nowMs() - startedAtMs);
}
