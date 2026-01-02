import { loadConfig, type RcAccountConfig, type RcBalanceConfig } from "./config";
import { fetchSubscriptionSummary, type SubscriptionSummary } from "./rightcode";

type Env = {
  RC_BALANCE_CONFIG: string;
  DB: D1Database;
};

type LeaseRecord = {
  accountId: string;
  expiresAt: number;
};

type PinRecord = {
  accountId: string;
  expiresAt: number;
};

type SubscriptionCacheRecord = {
  fetchedAt: number;
  summary: SubscriptionSummary;
};

type SelectRequest = {
  routeKey?: string;
  excludeAccountIds?: string[];
};

type SelectResponse = {
  accountId: string;
  leaseId: string;
  upstreamBaseUrl: string;
  upstreamResponsesPath: string;
};

type CooldownRequest = {
  accountId: string;
  ttlMs?: number;
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function nowMs(): number {
  return Date.now();
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

function compareConfigOrder(order: string[], a: string, b: string): number {
  return order.indexOf(a) - order.indexOf(b);
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

function parseBooleanish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const asNumber = parseFiniteNumber(value);
  if (asNumber !== undefined) return asNumber !== 0;
  const asString = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (asString === "true") return true;
  if (asString === "false") return false;
  return undefined;
}

const SUBSCRIPTION_TABLE = "rc_balance_subscription_snapshots";

export class RouterDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly config: RcBalanceConfig;
  private readonly accountById: Map<string, RcAccountConfig>;
  private readonly accountOrder: string[];
  private subscriptionCache?: { loadedAt: number; maxFetchedAt: number; data: Map<string, SubscriptionCacheRecord> };
  private inFlightRefresh?: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.config = loadConfig(env as unknown as Record<string, unknown>);
    this.accountById = new Map(this.config.accounts.map((account) => [account.label, account]));
    this.accountOrder = this.config.accounts.map((account) => account.label);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/select") {
      const body = (await request.json().catch(() => ({}))) as unknown;
      const parsed = (typeof body === "object" && body !== null ? body : {}) as SelectRequest;
      const routeKey = typeof parsed.routeKey === "string" && parsed.routeKey.trim() ? parsed.routeKey.trim() : undefined;
      const excludeAccountIds = Array.isArray(parsed.excludeAccountIds)
        ? parsed.excludeAccountIds.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
        : [];

      try {
        const exclude = new Set(excludeAccountIds.filter((id) => this.accountById.has(id)));
        const result = await this.state.blockConcurrencyWhile(() => this.selectAndAcquireSafe({ routeKey, exclude }));
        if ("error" in result) {
          return jsonResponse({ error: result.error }, { status: 429 });
        }
        return jsonResponse(result.selection);
      } catch (error) {
        const errorId = randomId("router_select_");
        const info = describeError(error);
        console.error("RouterDO /select failed", {
          errorId,
          message: info.message,
          stack: info.stack,
          excludeCount: excludeAccountIds.length,
          hasRouteKey: Boolean(routeKey),
        });
        return jsonResponse({ error: "Internal router error", error_code: "router_select_failed", error_id: errorId }, { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = (await request.json().catch(() => ({}))) as unknown;
      const leaseId = typeof (body as any)?.leaseId === "string" ? (body as any).leaseId : "";
      if (!leaseId) {
        return jsonResponse({ error: "Missing leaseId" }, { status: 400 });
      }
      await this.state.blockConcurrencyWhile(() => this.releaseLease(leaseId));
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/cooldown") {
      const body = (await request.json().catch(() => ({}))) as unknown;
      const parsed = (typeof body === "object" && body !== null ? body : {}) as CooldownRequest;
      const accountId = typeof parsed.accountId === "string" ? parsed.accountId.trim() : "";
      const ttlMs = typeof parsed.ttlMs === "number" && Number.isFinite(parsed.ttlMs) ? parsed.ttlMs : this.config.cooldown429Ms;

      if (!accountId || !this.accountById.has(accountId)) {
        return jsonResponse({ error: "Invalid accountId" }, { status: 400 });
      }

      await this.state.blockConcurrencyWhile(() => this.setCooldown(accountId, Math.max(0, Math.floor(ttlMs))));
      return jsonResponse({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(() => this.cleanupExpiredRecords());
  }

  private async selectAndAcquireSafe(params: { routeKey?: string; exclude?: Set<string> }): Promise<
    | { selection: SelectResponse }
    | { error: string }
  > {
    const subscriptions = await this.getSubscriptionSnapshotsCached();
    this.kickRefreshIfStale(subscriptions);
    const inflight = await this.getInflightMap();
    const cooldowns = await this.getCooldownMap();

    const picked = await this.pickAccountOrNull({
      routeKey: params.routeKey,
      exclude: params.exclude,
      inflight,
      cooldowns,
      subscriptions,
    });

    if (!picked) {
      return { error: "No available accounts (all at concurrency limit or out of quota)" };
    }

    const leaseId = randomId("lease_");
    const expiresAt = nowMs() + this.config.leaseTtlMs;
    const leaseKey = `lease:${leaseId}`;

    await this.state.storage.put(leaseKey, { accountId: picked.accountId, expiresAt } satisfies LeaseRecord);
    await this.state.storage.put(`inflight:${picked.accountId}`, (inflight.get(picked.accountId) ?? 0) + 1);

    await this.scheduleCleanupAlarm();

    return {
      selection: {
        accountId: picked.accountId,
        leaseId,
        upstreamBaseUrl: this.config.upstreamBaseUrl,
        upstreamResponsesPath: this.config.upstreamResponsesPath,
      },
    };
  }

  private async releaseLease(leaseId: string): Promise<void> {
    const leaseKey = `lease:${leaseId}`;
    const lease = await this.state.storage.get<LeaseRecord>(leaseKey);
    if (!lease) return;

    const current = (await this.state.storage.get<number>(`inflight:${lease.accountId}`)) ?? 0;
    await this.state.storage.put(`inflight:${lease.accountId}`, Math.max(0, current - 1));
    await this.state.storage.delete(leaseKey);
  }

  private async pickAccountOrNull(params: {
    routeKey?: string;
    exclude?: Set<string>;
    inflight: Map<string, number>;
    cooldowns: Map<string, number>;
    subscriptions: Map<string, SubscriptionCacheRecord>;
  }): Promise<{ accountId: string } | null> {
    const exclude = params.exclude ?? new Set<string>();
    const candidates = this.config.accounts.map((account) => {
      const inflight = params.inflight.get(account.label) ?? 0;
      const cooldownUntil = params.cooldowns.get(account.label) ?? 0;
      const isCoolingDown = cooldownUntil > nowMs();
      const subscription = params.subscriptions.get(account.label)?.summary;
      const isReset = subscription ? subscription.resetToday : undefined;
      const remaining = subscription ? subscription.remainingQuota : undefined;
      const atConcurrencyLimit = inflight >= account.concurrency;

      // Semantics from RightCode usage:
      // - resetToday=true  => remainingQuota is the "final" remaining for today, treat <=0 as unavailable.
      // - resetToday=false => when the remaining is consumed it flips to resetToday=true and usage resets to 0,
      //                      so we allow routing to unreset accounts even if remainingQuota looks low/stale.
      const hasQuota = subscription === undefined ? true : subscription.resetToday ? subscription.remainingQuota > 0 : true;

      return {
        account,
        inflight,
        cooldownUntil,
        isCoolingDown,
        subscription,
        isReset,
        remaining,
        atConcurrencyLimit,
        hasQuota,
      };
    });

    const usable = candidates.filter(
      (c) => !exclude.has(c.account.label) && !c.atConcurrencyLimit && !c.isCoolingDown && c.hasQuota,
    );
    if (usable.length === 0) {
      return null;
    }

    if (params.routeKey) {
      const pinned = await this.getPinnedAccount(params.routeKey);
      if (pinned) {
        const pinnedCandidate = usable.find((c) => c.account.label === pinned.accountId);
        if (pinnedCandidate) {
          await this.touchPinnedAccountIfNeeded(params.routeKey, pinned);
          return { accountId: pinnedCandidate.account.label };
        }
      }
    }

    let chosen: { account: RcAccountConfig; remaining: number | undefined; inflight: number } | undefined;

    // Single routing policy:
    // 1) If there are any unreset accounts (resetToday=false), prefer draining them to reset (closest-to-reset first).
    // 2) Once all accounts are resetToday=true, prefer the account with the most remaining quota.
    const unresetUsable = usable.filter((c) => c.subscription && c.subscription.resetToday === false);
    if (unresetUsable.length > 0) {
      const drainAccountId = await this.pickOrUpdateDrainAccountId(unresetUsable);
      if (drainAccountId) {
        const drain = unresetUsable.find((c) => c.account.label === drainAccountId);
        if (drain) chosen = drain;
      }
    }

    if (!chosen) {
      chosen = this.pickByRemainingThenInflight(usable);
    }

    if (params.routeKey) {
      await this.setPinnedAccountId(params.routeKey, chosen.account.label);
    }

    return { accountId: chosen.account.label };
  }

  private pickByRemainingThenInflight(candidates: Array<{ remaining: number | undefined; inflight: number; account: RcAccountConfig }>) {
    return [...candidates].sort((a, b) => {
      const remainingA = a.remaining ?? -Infinity;
      const remainingB = b.remaining ?? -Infinity;
      if (remainingA !== remainingB) return remainingB - remainingA;
      if (a.inflight !== b.inflight) return a.inflight - b.inflight;
      return compareConfigOrder(this.accountOrder, a.account.label, b.account.label);
    })[0]!;
  }

  private async pickOrUpdateDrainAccountId(
    unresetUsable: Array<{ account: RcAccountConfig; remaining: number | undefined; inflight: number }>,
  ): Promise<string | undefined> {
    if (unresetUsable.length === 0) return undefined;

    const existing = await this.state.storage.get<string>("drainAccountId");
    if (existing) {
      const stillUsable = unresetUsable.some((c) => c.account.label === existing);
      if (stillUsable) return existing;
    }

    // Pick the account closest to reset first (smallest remaining quota).
    // If remaining is unavailable, treat it as "farther" from reset.
    const next = [...unresetUsable].sort((a, b) => {
      const remainingA = a.remaining ?? Infinity;
      const remainingB = b.remaining ?? Infinity;
      if (remainingA !== remainingB) return remainingA - remainingB;
      if (a.inflight !== b.inflight) return a.inflight - b.inflight;
      return compareConfigOrder(this.accountOrder, a.account.label, b.account.label);
    })[0];

    if (next) {
      await this.state.storage.put("drainAccountId", next.account.label);
      return next.account.label;
    }

    await this.state.storage.delete("drainAccountId");
    return undefined;
  }

  private async getPinnedAccount(routeKey: string): Promise<PinRecord | undefined> {
    const key = `pin:${routeKey}`;
    const record = await this.state.storage.get<PinRecord>(key);
    if (!record) return undefined;
    if (record.expiresAt <= nowMs()) {
      await this.state.storage.delete(key);
      return undefined;
    }
    return record;
  }

  private async touchPinnedAccountIfNeeded(routeKey: string, record: PinRecord): Promise<void> {
    const remainingTtlMs = record.expiresAt - nowMs();
    const refreshThresholdMs = Math.max(10_000, Math.floor(this.config.promptCacheKeyTtlMs / 3));
    if (remainingTtlMs > refreshThresholdMs) return;
    await this.setPinnedAccountId(routeKey, record.accountId);
  }

  private async setPinnedAccountId(routeKey: string, accountId: string): Promise<void> {
    const key = `pin:${routeKey}`;
    await this.state.storage.put(key, {
      accountId,
      expiresAt: nowMs() + this.config.promptCacheKeyTtlMs,
    } satisfies PinRecord);
  }

  private async getInflightMap(): Promise<Map<string, number>> {
    const entries = await this.state.storage.list<number>({ prefix: "inflight:" });
    const map = new Map<string, number>();
    for (const [key, value] of entries) {
      const accountId = key.slice("inflight:".length);
      if (!accountId) continue;
      map.set(accountId, typeof value === "number" && Number.isFinite(value) ? value : 0);
    }
    return map;
  }

  private async getCooldownMap(): Promise<Map<string, number>> {
    const entries = await this.state.storage.list<number>({ prefix: "cooldown:" });
    const map = new Map<string, number>();
    for (const [key, value] of entries) {
      const accountId = key.slice("cooldown:".length);
      if (!accountId) continue;
      map.set(accountId, typeof value === "number" && Number.isFinite(value) ? value : 0);
    }
    return map;
  }

  private async setCooldown(accountId: string, ttlMs: number): Promise<void> {
    const normalizedTtlMs = Math.max(0, Math.floor(ttlMs));
    if (normalizedTtlMs <= 0) {
      await this.state.storage.delete(`cooldown:${accountId}`);
      return;
    }

    const until = nowMs() + normalizedTtlMs;
    await this.state.storage.put(`cooldown:${accountId}`, until);
    await this.scheduleCleanupAlarm();
  }

  private async getSubscriptionSnapshotsCached(): Promise<Map<string, SubscriptionCacheRecord>> {
    const cacheTtlMs = 5_000;
    const cached = this.subscriptionCache;
    if (cached && nowMs() - cached.loadedAt <= cacheTtlMs) {
      return cached.data;
    }

    const data = await this.loadSubscriptionSnapshotsFromD1();
    let maxFetchedAt = 0;
    for (const record of data.values()) maxFetchedAt = Math.max(maxFetchedAt, record.fetchedAt);
    this.subscriptionCache = { loadedAt: nowMs(), maxFetchedAt, data };
    return data;
  }

  private kickRefreshIfStale(subscriptions: Map<string, SubscriptionCacheRecord>): void {
    const maxFetchedAt =
      this.subscriptionCache?.data === subscriptions ? this.subscriptionCache.maxFetchedAt : Math.max(...[...subscriptions.values()].map((r) => r.fetchedAt), 0);
    const staleAfterMs = Math.max(30_000, this.config.subscriptionRefreshMs * 2);
    if (maxFetchedAt > 0 && nowMs() - maxFetchedAt <= staleAfterMs) return;

    const lastKickPromise = this.state.storage.get<number>("subsRefresh:lastKickAt");
    // Fire-and-forget; DO is single-threaded, keep it best-effort.
    void lastKickPromise.then((lastKickAt) => {
      const last = typeof lastKickAt === "number" ? lastKickAt : 0;
      if (nowMs() - last < staleAfterMs) return;
      if (this.inFlightRefresh) return;
      this.inFlightRefresh = this.refreshSubscriptions()
        .catch((error) => {
          console.error("On-demand subscription refresh failed", error);
        })
        .finally(() => {
          this.inFlightRefresh = undefined;
        });
    });
  }

  private async refreshSubscriptions(): Promise<void> {
    const fetchedAt = nowMs();
    await this.state.storage.put("subsRefresh:lastKickAt", fetchedAt);

    const results = await Promise.all(
      this.config.accounts.map(async (account) => {
        try {
          const summary = await fetchSubscriptionSummary({
            subscriptionListUrl: this.config.subscriptionListUrl,
            jwt: account.jwt,
            token: account.token,
            requestTimeoutMs: 8_000,
          });
          return { accountId: account.label, summary };
        } catch {
          return { accountId: account.label, summary: undefined };
        }
      }),
    );

    const snapshots = results
      .filter((r): r is { accountId: string; summary: SubscriptionSummary } => r.summary !== undefined)
      .map((r) => ({ accountId: r.accountId, record: { fetchedAt, summary: r.summary } satisfies SubscriptionCacheRecord }));

    if (snapshots.length === 0) return;

    const upsert = this.env.DB.prepare(
      `INSERT INTO ${SUBSCRIPTION_TABLE} (account_label, fetched_at, total_quota, remaining_quota, reset_today, last_reset_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_label) DO UPDATE SET
         fetched_at=excluded.fetched_at,
         total_quota=excluded.total_quota,
         remaining_quota=excluded.remaining_quota,
         reset_today=excluded.reset_today,
         last_reset_at=excluded.last_reset_at`,
    );

    await this.env.DB.batch(
      snapshots.map(({ accountId, record }) =>
        upsert.bind(
          accountId,
          record.fetchedAt,
          record.summary.totalQuota,
          record.summary.remainingQuota,
          record.summary.resetToday ? 1 : 0,
          record.summary.lastResetAt ?? null,
        ),
      ),
    );

    // Bust cache so subsequent selects use fresh data.
    this.subscriptionCache = undefined;
  }

  private async loadSubscriptionSnapshotsFromD1(): Promise<Map<string, SubscriptionCacheRecord>> {
    const map = new Map<string, SubscriptionCacheRecord>();

    try {
      const result = await this.env.DB.prepare(
        `SELECT account_label, fetched_at, total_quota, remaining_quota, reset_today, last_reset_at
         FROM ${SUBSCRIPTION_TABLE}`,
      ).all();

      const rows = Array.isArray((result as any).results) ? ((result as any).results as any[]) : [];
      for (const row of rows) {
        const accountLabel = parseString(row?.account_label) ?? "";
        if (!accountLabel || !this.accountById.has(accountLabel)) continue;

        const fetchedAt = parseFiniteNumber(row?.fetched_at);
        const totalQuota = parseFiniteNumber(row?.total_quota);
        const remainingQuota = parseFiniteNumber(row?.remaining_quota);
        const resetToday = parseBooleanish(row?.reset_today);
        const lastResetAt = row?.last_reset_at === null ? null : parseString(row?.last_reset_at);

        if (fetchedAt === undefined || totalQuota === undefined || remainingQuota === undefined || resetToday === undefined) {
          continue;
        }

        map.set(accountLabel, {
          fetchedAt,
          summary: {
            totalQuota,
            remainingQuota,
            resetToday,
            lastResetAt,
          },
        });
      }
    } catch (error) {
      console.error("Failed to load subscription snapshots from D1", error);
    }

    return map;
  }

  private async cleanupExpiredRecords(): Promise<void> {
    const now = nowMs();
    const leases = await this.state.storage.list<LeaseRecord>({ prefix: "lease:" });
    for (const [key, lease] of leases) {
      if (!lease || typeof lease.expiresAt !== "number" || typeof lease.accountId !== "string") {
        await this.state.storage.delete(key);
        continue;
      }
      if (lease.expiresAt > now) continue;
      const current = (await this.state.storage.get<number>(`inflight:${lease.accountId}`)) ?? 0;
      await this.state.storage.put(`inflight:${lease.accountId}`, Math.max(0, current - 1));
      await this.state.storage.delete(key);
    }

    const pins = await this.state.storage.list<PinRecord>({ prefix: "pin:" });
    for (const [key, record] of pins) {
      if (!record || typeof record.expiresAt !== "number") {
        await this.state.storage.delete(key);
        continue;
      }
      if (record.expiresAt <= now) {
        await this.state.storage.delete(key);
      }
    }

    const cooldowns = await this.state.storage.list<number>({ prefix: "cooldown:" });
    for (const [key, until] of cooldowns) {
      if (typeof until !== "number" || !Number.isFinite(until)) {
        await this.state.storage.delete(key);
        continue;
      }
      if (until <= now) {
        await this.state.storage.delete(key);
      }
    }
  }

  private async scheduleCleanupAlarm(): Promise<void> {
    const scheduled = await this.state.storage.get<number>("alarm:scheduledAt");
    const next = nowMs() + 60_000;
    if (scheduled && scheduled > nowMs()) return;
    await this.state.storage.put("alarm:scheduledAt", next);
    await this.state.storage.setAlarm(next);
  }
}

// v2 "fresh class" for isolating DO/SQLite state (same code, new storage namespace).
export class RouterDOv2 extends RouterDO {}
