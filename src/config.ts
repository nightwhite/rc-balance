export type RcAccountConfig = {
  label: string;
  jwt: string;
  token: string;
  concurrency: number;
};

export type RcBalanceConfig = {
  accounts: RcAccountConfig[];
  upstreamBaseUrl: string;
  upstreamResponsesPath: string;
  upstreamChatCompletionsPath: string;
  subscriptionListUrl: string;
  subscriptionRefreshMs: number;
  promptCacheKeyTtlMs: number;
  leaseTtlMs: number;
  cooldown429Ms: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeTokenInput(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^authorization\\s*:\\s*/i, "");
  normalized = normalized.replace(/^bearer\\s+/i, "");
  normalized = normalized.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

type RawAccount =
  | {
      label?: unknown;
      description?: unknown;
      desc?: unknown;
      alias?: unknown;
      name?: unknown;
      jwt?: unknown;
      apiKey?: unknown;
      api_key?: unknown;
      token?: unknown;
      concurrency?: unknown;
    }
  | Record<string, unknown>;

function parseAccountsFromUnknown(raw: unknown): RcAccountConfig[] {
  const defaultConcurrency = 10;
  const accounts: RcAccountConfig[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const label = (
        parseString(item.label) ??
        parseString(item.description) ??
        parseString(item.desc) ??
        parseString(item.name) ??
        parseString(item.alias) ??
        ""
      ).trim();
      const jwt = normalizeTokenInput(parseString(item.jwt) ?? "");
      const token = normalizeTokenInput(
        parseString(item.apiKey ?? item.api_key ?? item.token) ?? "",
      );
      const concurrency = parseFiniteNumber(item.concurrency) ?? defaultConcurrency;
      if (!label || !jwt || !token) continue;
      accounts.push({
        label,
        jwt,
        token,
        concurrency: Math.max(1, Math.floor(concurrency)),
      });
    }
    return accounts;
  }

  if (isRecord(raw)) {
    if (raw.accounts !== undefined) {
      return parseAccountsFromUnknown(raw.accounts);
    }

    // Support `{ "work": "TOKEN", "personal": "TOKEN2" }` (legacy: use the same token for both jwt and token)
    const looksLikeMap = Object.values(raw).every((v) => typeof v === "string" || v === undefined);
    if (looksLikeMap) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== "string") continue;
        const label = key.trim();
        const token = normalizeTokenInput(value);
        if (!label || !token) continue;
        accounts.push({ label, jwt: token, token, concurrency: defaultConcurrency });
      }
      return accounts;
    }

    // Support `{ "work": { jwt, token, concurrency } }` (also accepts `apiKey`)
    for (const [key, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      const label = key.trim();
      const jwt = normalizeTokenInput(parseString(value.jwt) ?? "");
      const token = normalizeTokenInput(parseString(value.apiKey ?? value.api_key ?? value.token) ?? "");
      const concurrency = parseFiniteNumber(value.concurrency) ?? defaultConcurrency;
      if (!label || !jwt || !token) continue;
      accounts.push({ label, jwt, token, concurrency: Math.max(1, Math.floor(concurrency)) });
    }
  }

  return [];
}

function uniqAccountsByLabel(accounts: RcAccountConfig[]): RcAccountConfig[] {
  const seen = new Set<string>();
  const result: RcAccountConfig[] = [];
  for (const account of accounts) {
    if (seen.has(account.label)) continue;
    seen.add(account.label);
    result.push(account);
  }
  return result;
}

export function loadConfig(env: Record<string, unknown>): RcBalanceConfig {
  const raw = parseString(env.RC_BALANCE_CONFIG) ?? "";
  if (!raw.trim()) {
    throw new Error("Missing RC_BALANCE_CONFIG (JSON)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid RC_BALANCE_CONFIG JSON: ${(error as Error).message}`);
  }

  const accounts = uniqAccountsByLabel(parseAccountsFromUnknown(parsed));
  if (accounts.length === 0) {
    throw new Error("RC_BALANCE_CONFIG must contain at least one account");
  }

  const upstreamBaseUrl =
    (isRecord(parsed) ? parseString(parsed.upstreamBaseUrl ?? parsed.upstream_base_url) : undefined) ??
    "https://www.right.codes";
  const upstreamResponsesPath =
    (isRecord(parsed) ? parseString(parsed.upstreamResponsesPath ?? parsed.upstream_responses_path) : undefined) ??
    "/codex/v1/responses";
  const upstreamChatCompletionsPath =
    (isRecord(parsed) ? parseString(parsed.upstreamChatCompletionsPath ?? parsed.upstream_chat_completions_path) : undefined) ??
    "/codex/v1/chat/completions";
  const subscriptionListUrl =
    (isRecord(parsed) ? parseString(parsed.subscriptionListUrl ?? parsed.subscription_list_url) : undefined) ??
    "https://right.codes/subscriptions/list";

  const subscriptionRefreshMs = Math.max(
    5_000,
    Math.floor((isRecord(parsed) ? parseFiniteNumber(parsed.subscriptionRefreshMs ?? parsed.subscription_refresh_ms) : undefined) ?? 60_000),
  );
  const promptCacheKeyTtlMs = Math.max(
    10_000,
    Math.floor((isRecord(parsed) ? parseFiniteNumber(parsed.promptCacheKeyTtlMs ?? parsed.prompt_cache_key_ttl_ms) : undefined) ?? 3_600_000),
  );
  const leaseTtlMs = Math.max(
    10_000,
    Math.floor((isRecord(parsed) ? parseFiniteNumber(parsed.leaseTtlMs ?? parsed.lease_ttl_ms) : undefined) ?? 15 * 60_000),
  );
  const cooldown429Ms = Math.max(
    0,
    Math.floor((isRecord(parsed) ? parseFiniteNumber(parsed.cooldown429Ms ?? parsed.cooldown_429_ms) : undefined) ?? 60_000),
  );

  return {
    accounts,
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/+$/, ""),
    upstreamResponsesPath,
    upstreamChatCompletionsPath,
    subscriptionListUrl,
    subscriptionRefreshMs,
    promptCacheKeyTtlMs,
    leaseTtlMs,
    cooldown429Ms,
  };
}
