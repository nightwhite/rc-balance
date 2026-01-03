export function isDebugEnabled(env: { RC_BALANCE_LOG_LEVEL?: string | undefined }): boolean {
  return String(env.RC_BALANCE_LOG_LEVEL ?? "").trim().toLowerCase() === "debug";
}

export type EventLogLevel = "error" | "info";

export function getEventLogLevel(env: { RC_BALANCE_EVENT_LOG_LEVEL?: string | undefined }): EventLogLevel {
  const raw = String(env.RC_BALANCE_EVENT_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "info") return "info";
  return "error";
}
