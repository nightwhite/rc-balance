export type RightCodeSubscription = {
  id: number;
  name: string;
  totalQuota: number;
  remainingQuota: number;
  lastResetAt?: string | null;
  createdAt?: string;
  resetToday?: boolean;
};

export type SubscriptionSummary = {
  totalQuota: number;
  remainingQuota: number;
  resetToday: boolean;
  lastResetAt?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function usedQuota(subscription: RightCodeSubscription): number {
  const used = subscription.totalQuota - subscription.remainingQuota;
  return used < 0 && used > -1e-8 ? 0 : used;
}

function createdAtMs(subscription: RightCodeSubscription): number {
  const value = subscription.createdAt;
  if (!value) return -Infinity;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function pickLatestPurchasedSubscription(subscriptions: RightCodeSubscription[]): RightCodeSubscription | undefined {
  if (subscriptions.length === 0) return undefined;
  let best = subscriptions[0]!;
  let bestMs = createdAtMs(best);
  for (const subscription of subscriptions) {
    const ms = createdAtMs(subscription);
    if (ms > bestMs || (ms === bestMs && subscription.id > best.id)) {
      best = subscription;
      bestMs = ms;
    }
  }
  return best;
}

function parseSubscription(raw: unknown): RightCodeSubscription | undefined {
  if (!isRecord(raw)) return undefined;

  const id = parseFiniteNumber(raw.id);
  const name = parseString(raw.name);
  const totalQuota = parseFiniteNumber(raw.total_quota);
  const remainingQuota = parseFiniteNumber(raw.remaining_quota);
  if (id === undefined || name === undefined || totalQuota === undefined || remainingQuota === undefined) {
    return undefined;
  }

  const lastResetAtRaw = raw.last_reset_at;
  const lastResetAt =
    lastResetAtRaw === null ? null : lastResetAtRaw === undefined ? undefined : parseString(lastResetAtRaw);

  return {
    id,
    name,
    totalQuota,
    remainingQuota,
    lastResetAt,
    createdAt: parseString(raw.created_at),
    resetToday: parseBoolean(raw.reset_today),
  };
}

export async function fetchSubscriptionSummary(params: {
  subscriptionListUrl: string;
  jwt: string;
  token: string;
  requestTimeoutMs: number;
}): Promise<SubscriptionSummary | undefined> {
  const authToken = (params.jwt || "").trim() || (params.token || "").trim();
  if (!authToken) {
    return undefined;
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), params.requestTimeoutMs);

  try {
    const response = await fetch(params.subscriptionListUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Subscription list failed: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Subscription list returned invalid JSON: ${text.slice(0, 200)}`);
    }

    if (!isRecord(parsed)) {
      throw new Error("Subscription list response is not an object");
    }

    const subscriptionsRaw = parsed.subscriptions;
    const subscriptions = Array.isArray(subscriptionsRaw)
      ? subscriptionsRaw
          .map(parseSubscription)
          .filter((value): value is RightCodeSubscription => value !== undefined)
      : [];

    const primary = pickLatestPurchasedSubscription(subscriptions);
    if (!primary) return undefined;

    return {
      totalQuota: primary.totalQuota,
      remainingQuota: primary.remainingQuota,
      resetToday: primary.resetToday ?? false,
      lastResetAt: primary.lastResetAt,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
