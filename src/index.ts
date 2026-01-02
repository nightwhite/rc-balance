import { loadConfig } from "./config";
import { RouterDO } from "./router-do";
import { fetchSubscriptionSummary, type SubscriptionSummary } from "./rightcode";

export { RouterDO };

type Env = {
  ROUTER: DurableObjectNamespace;
  RC_BALANCE_CONFIG: string;
  RC_BALANCE_PROXY_TOKEN?: string;
  DB: D1Database;
};

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

let cachedConfigRaw: string | undefined;
let cachedConfig: ReturnType<typeof loadConfig> | undefined;

function getConfig(env: Env): ReturnType<typeof loadConfig> {
  const raw = env.RC_BALANCE_CONFIG;
  if (cachedConfig && cachedConfigRaw === raw) return cachedConfig;
  cachedConfigRaw = raw;
  cachedConfig = loadConfig(env as unknown as Record<string, unknown>);
  return cachedConfig;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

async function readRequestBodyText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error("Request body too large");
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function parseRouteKeyFromBody(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = (parsed as any).prompt_cache_key;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeResponsesInput(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return [
      {
        role: "user",
        content: [{ type: "input_text", text: value }],
      },
    ];
  }
  return undefined;
}

function sanitizeResponsesRequestBody(value: unknown): { json: unknown; changed: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { json: value, changed: false };

  const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  let changed = false;

  const normalizedInput = normalizeResponsesInput(clone.input);
  if (normalizedInput) {
    clone.input = normalizedInput;
    changed = true;
  }

  const instructions = typeof clone.instructions === "string" ? clone.instructions : undefined;
  if (instructions && instructions.trim()) {
    const input = Array.isArray(clone.input) ? (clone.input as unknown[]) : [];
    clone.input = [
      {
        role: "developer",
        content: [{ type: "input_text", text: instructions }],
      },
      ...input,
    ];
    delete clone.instructions;
    changed = true;
  }

  return { json: clone, changed };
}

function parseRouteKeyFromHeaders(headers: Headers): string | undefined {
  // Some clients (e.g. Codex integrations) may send a stable conversation/session id as a header.
  // We use it only for our own routing (do not forward / do not rewrite body).
  const candidates = [
    "prompt_cache_key",
    "conversation_id",
    "session_id",
    "x-prompt-cache-key",
    "x-rc-route-key",
  ];
  for (const name of candidates) {
    const value = headers.get(name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function getBearerToken(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(trimmed);
  const token = (match?.[1] ?? "").trim();
  return token ? token : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const required = typeof env.RC_BALANCE_PROXY_TOKEN === "string" ? env.RC_BALANCE_PROXY_TOKEN.trim() : "";
  if (!required) return true;
  const provided = getBearerToken(request.headers.get("authorization")) ?? "";
  return provided ? timingSafeEqual(provided, required) : false;
}

function buildUpstreamHeaders(request: Request, accountToken: string): Headers {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${accountToken}`);

  // Ensure required defaults.
  if (!headers.get("content-type")) headers.set("content-type", "application/json");
  if (!headers.get("accept")) headers.set("accept", "*/*");

  // Remove headers that should not be forwarded.
  headers.delete("content-length");
  headers.delete("host");
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }

  // Internal routing headers are not part of upstream API.
  const internalKeys: string[] = [];
  headers.forEach((_value, key) => {
    if (key.toLowerCase().startsWith("x-rc-")) internalKeys.push(key);
  });
  for (const key of internalKeys) headers.delete(key);

  return headers;
}

function shouldFailoverUpstreamStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().startsWith("text/event-stream");
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const EVENTS_TABLE = "rc_balance_events";

async function logEvent(env: Env, event: {
  kind: string;
  accountLabel?: string;
  routeKey?: string;
  upstreamStatus?: number;
  detail?: string;
}): Promise<void> {
  const ts = Date.now();
  const id = randomId("evt_");
  const routeKeyHash = event.routeKey ? (await sha256Hex(event.routeKey)).slice(0, 32) : null;
  const accountLabel = event.accountLabel ?? null;
  const upstreamStatus = typeof event.upstreamStatus === "number" ? event.upstreamStatus : null;
  const detail = event.detail ?? null;

  await env.DB.prepare(
    `INSERT INTO ${EVENTS_TABLE} (id, ts, kind, account_label, route_key_hash, upstream_status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, ts, event.kind, accountLabel, routeKeyHash, upstreamStatus, detail).run();
}

type SubscriptionSnapshotRecord = {
  fetchedAt: number;
  summary: SubscriptionSummary;
};

const SUBSCRIPTION_TABLE = "rc_balance_subscription_snapshots";

async function markAccountOutOfQuotaToday(env: Env, params: { accountLabel: string; fetchedAt: number }): Promise<void> {
  const upsert = env.DB.prepare(
    `INSERT INTO ${SUBSCRIPTION_TABLE} (account_label, fetched_at, total_quota, remaining_quota, reset_today, last_reset_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_label) DO UPDATE SET
       fetched_at=excluded.fetched_at,
       remaining_quota=excluded.remaining_quota,
       reset_today=excluded.reset_today`,
  );
  await upsert.bind(params.accountLabel, params.fetchedAt, 0, 0, 1, null).run();
}

async function refreshSubscriptions(env: Env): Promise<void> {
  const config = getConfig(env);
  const fetchedAt = Date.now();

  const results = await Promise.all(
    config.accounts.map(async (account) => {
      try {
        const summary = await fetchSubscriptionSummary({
          subscriptionListUrl: config.subscriptionListUrl,
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
    .map((r) => ({ accountId: r.accountId, record: { fetchedAt, summary: r.summary } satisfies SubscriptionSnapshotRecord }));

  if (snapshots.length === 0) return;

  const upsert = env.DB.prepare(
    `INSERT INTO ${SUBSCRIPTION_TABLE} (account_label, fetched_at, total_quota, remaining_quota, reset_today, last_reset_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_label) DO UPDATE SET
       fetched_at=excluded.fetched_at,
       total_quota=excluded.total_quota,
       remaining_quota=excluded.remaining_quota,
       reset_today=excluded.reset_today,
       last_reset_at=excluded.last_reset_at`,
  );

  await env.DB.batch(
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const config = getConfig(env);
        return jsonResponse({
          ok: true,
          accounts: {
            count: config.accounts.length,
            totalConcurrency: config.accounts.reduce((sum, account) => sum + account.concurrency, 0),
          },
          subscriptionRefreshMs: config.subscriptionRefreshMs,
          promptCacheKeyTtlMs: config.promptCacheKeyTtlMs,
        });
      } catch (error) {
        return jsonResponse({ ok: false, error: (error as Error).message }, { status: 500 });
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Proxy OpenAI-style endpoints.
    // - POST /v1/responses
    // - POST /v1/chat/completions
    const isResponses = url.pathname === "/v1/responses";
    const isChatCompletions = url.pathname === "/v1/chat/completions";
    if (!isResponses && !isChatCompletions) {
      return new Response("Not found", { status: 404 });
    }

    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const config = getConfig(env);

    let rawBodyText = "";
    try {
      rawBodyText = await readRequestBodyText(request, MAX_REQUEST_BODY_BYTES);
    } catch {
      return new Response("Payload too large", { status: 413 });
    }
    let bodyJson: unknown = undefined;
    try {
      bodyJson = rawBodyText ? (JSON.parse(rawBodyText) as unknown) : undefined;
    } catch {
      bodyJson = undefined;
    }

    const routeKey = parseRouteKeyFromBody(bodyJson) ?? parseRouteKeyFromHeaders(request.headers);
    const upstreamBodyText = (() => {
      if (!isResponses) return rawBodyText;
      if (!bodyJson) return rawBodyText;
      const { json, changed } = sanitizeResponsesRequestBody(bodyJson);
      return changed ? JSON.stringify(json) : rawBodyText;
    })();

    const stub = env.ROUTER.get(env.ROUTER.idFromName("router"));
    const excludedAccountIds = new Set<string>();
    const maxAttempts = routeKey ? Math.max(1, config.accounts.length) : 1;

    const upstreamPath = isChatCompletions ? config.upstreamChatCompletionsPath : config.upstreamResponsesPath;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let selectResponse: Response;
      try {
        selectResponse = await stub.fetch("https://router/select", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            routeKey,
            excludeAccountIds: excludedAccountIds.size ? [...excludedAccountIds] : undefined,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.waitUntil(
          logEvent(env, {
            kind: "router_select_failed",
            routeKey,
            detail: message,
          }).catch(() => {}),
        );
        if (message.includes("No available accounts")) {
          return jsonResponse({ error: "No available accounts (all at concurrency limit or out of quota)" }, { status: 503 });
        }
        return jsonResponse({ error: "Router select failed" }, { status: 503 });
      }

      if (!selectResponse.ok) {
        const contentType = (selectResponse.headers.get("content-type") ?? "").toLowerCase();
        const text = await selectResponse.text();
        let message = text;
        if (contentType.includes("application/json")) {
          try {
            const parsed = JSON.parse(text) as any;
            if (typeof parsed?.error === "string" && parsed.error.trim()) {
              message = parsed.error.trim();
            }
          } catch {}
        }
        ctx.waitUntil(
          logEvent(env, {
            kind: "router_select_unavailable",
            routeKey,
            upstreamStatus: selectResponse.status,
            detail: message.slice(0, 500),
          }).catch(() => {}),
        );
        const outwardStatus = selectResponse.status === 429 ? 503 : selectResponse.status;
        return jsonResponse({ error: message || "No available accounts" }, { status: outwardStatus });
      }

      const selected = (await selectResponse.json().catch(() => null)) as any;
      const accountId = typeof selected?.accountId === "string" ? selected.accountId : "";
      const leaseId = typeof selected?.leaseId === "string" ? selected.leaseId : "";
      const upstreamBaseUrl = typeof selected?.upstreamBaseUrl === "string" ? selected.upstreamBaseUrl : config.upstreamBaseUrl;

      const account = config.accounts.find((a) => a.label === accountId);
      const release = async () => {
        if (!leaseId) return;
        try {
          await stub.fetch("https://router/release", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ leaseId }),
          });
        } catch {}
      };

      if (!account || !leaseId) {
        ctx.waitUntil(release());
        return jsonResponse({ error: "Invalid router selection" }, { status: 500 });
      }

      const upstreamUrl = `${upstreamBaseUrl}${upstreamPath}`;
      const headers = buildUpstreamHeaders(request, account.token);

      // Best-effort: preserve RightCode's SSE behavior.
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(upstreamUrl, {
          method: "POST",
          headers,
          body: upstreamBodyText,
        });
      } catch (error) {
        ctx.waitUntil(release());
        ctx.waitUntil(
          logEvent(env, {
            kind: "upstream_fetch_failed",
            accountLabel: accountId,
            routeKey,
            detail: error instanceof Error ? error.message : String(error),
          }).catch(() => {}),
        );
        return jsonResponse(
          { error: "Upstream fetch failed", detail: error instanceof Error ? error.message : String(error) },
          { status: 502 },
        );
      }

      if (upstreamResponse.status === 429) {
        ctx.waitUntil(
          stub
            .fetch("https://router/cooldown", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ accountId, ttlMs: config.cooldown429Ms }),
            })
            .catch(() => {}),
        );
      }

      const downstreamHeaders = new Headers(upstreamResponse.headers);
      const isFailoverStatus = shouldFailoverUpstreamStatus(upstreamResponse.status);
      const hasMoreCandidates = excludedAccountIds.size + 1 < config.accounts.length;

      // If upstream returns a non-SSE error body, prefer reading it so we can:
      // - log a short error detail
      // - detect "余额不足" and immediately mark the account as out-of-quota in D1 (so selection excludes it)
      // - optionally failover to another account
      if (upstreamResponse.status >= 400 && !isEventStream(upstreamResponse)) {
        const text = await upstreamResponse.text();
        const insufficientBalance = (() => {
          try {
            const parsed = JSON.parse(text) as any;
            const message = typeof parsed?.error === "string" ? parsed.error : "";
            return message.includes("余额不足");
          } catch {
            return text.includes("余额不足");
          }
        })();

        if (insufficientBalance) {
          ctx.waitUntil(
            markAccountOutOfQuotaToday(env, { accountLabel: accountId, fetchedAt: Date.now() }).catch(() => {}),
          );
          ctx.waitUntil(
            logEvent(env, {
              kind: "insufficient_balance",
              accountLabel: accountId,
              routeKey,
              upstreamStatus: upstreamResponse.status,
              detail: text.slice(0, 500),
            }).catch(() => {}),
          );
        } else {
          ctx.waitUntil(
            logEvent(env, {
              kind: "upstream_error",
              accountLabel: accountId,
              routeKey,
              upstreamStatus: upstreamResponse.status,
              detail: text.slice(0, 500),
            }).catch(() => {}),
          );
        }

        if (isFailoverStatus && hasMoreCandidates) {
          excludedAccountIds.add(accountId);
          await release();
          continue;
        }

        ctx.waitUntil(release());
        // Do not leak upstream raw error payloads to clients; keep status code as-is for compatibility.
        const clientMessage = insufficientBalance ? "余额不足" : "Upstream error";
        return jsonResponse({ error: clientMessage }, { status: upstreamResponse.status });
      }

      const shouldFailover = isFailoverStatus && hasMoreCandidates;
      if (shouldFailover) {
        excludedAccountIds.add(accountId);
        ctx.waitUntil(
          logEvent(env, {
            kind: "failover",
            accountLabel: accountId,
            routeKey,
            upstreamStatus: upstreamResponse.status,
          }).catch(() => {}),
        );
        upstreamResponse.body?.cancel().catch(() => {});
        await release();
        continue;
      }

      if (!upstreamResponse.body) {
        const text = await upstreamResponse.text();
        ctx.waitUntil(release());
        if (upstreamResponse.status >= 400) {
          ctx.waitUntil(
            logEvent(env, {
              kind: "upstream_error",
              accountLabel: accountId,
              routeKey,
              upstreamStatus: upstreamResponse.status,
              detail: text.slice(0, 500),
            }).catch(() => {}),
          );
        }
        return new Response(text, { status: upstreamResponse.status, headers: downstreamHeaders });
      }

      const { readable, writable } = new TransformStream();
      ctx.waitUntil(
        upstreamResponse.body
          .pipeTo(writable, { signal: request.signal })
          .catch(() => {})
          .finally(release),
      );

      if (upstreamResponse.status >= 400) {
        ctx.waitUntil(
          logEvent(env, {
            kind: "upstream_error_stream",
            accountLabel: accountId,
            routeKey,
            upstreamStatus: upstreamResponse.status,
          }).catch(() => {}),
        );
      }

      return new Response(readable, { status: upstreamResponse.status, headers: downstreamHeaders });
    }

    return jsonResponse({ error: "Failed to select an available account" }, { status: 503 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshSubscriptions(env).catch((error) => {
        console.error("Subscription refresh failed", error);
      }),
    );
  },
};
