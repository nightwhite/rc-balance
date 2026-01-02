export function isDebugEnabled(env: { RC_BALANCE_LOG_LEVEL?: string | undefined }): boolean {
  return String(env.RC_BALANCE_LOG_LEVEL ?? "").trim().toLowerCase() === "debug";
}

