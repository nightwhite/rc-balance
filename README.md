# rc-balance

一个部署在 Cloudflare Workers 上的 [RightCode](https://www.right.codes/register?aff=b9f13319) 请求代理与账号均衡器。

目标：
- 用一个 JSON 配置多个账号（每个账号包含 `jwt` + `token`）
- 按账号配置并发上限（默认 10）
- 基于 `subscriptions/list` 的 `reset_today` + `remaining_quota` 做“先跑到已重置，再跑剩余”的选号策略（订阅数据由 Cron 定时刷新缓存）
- 当请求带 `prompt_cache_key` 时尽量粘住同一账号，提升 Prompt Caching 命中率

## 配置

通过 Workers 环境变量 `RC_BALANCE_CONFIG` 传入 JSON（本仓库示例默认写在 `wrangler.toml` 的 `[vars]`；如需更安全的方式可改用 Cloudflare Dashboard 的 Secrets）。

最小示例：

```json
{
  "accounts": [
    { "label": "工作", "jwt": "YOUR_JWT_1", "token": "YOUR_TOKEN_1", "concurrency": 10 },
    { "label": "个人", "jwt": "YOUR_JWT_2", "token": "YOUR_TOKEN_2", "concurrency": 10 }
  ],
  "subscriptionRefreshMs": 60000,
  "promptCacheKeyTtlMs": 3600000
}
```

字段说明：
- `label`: 账号备注（仅用于内部路由/日志；默认不会返回给客户端）
- `jwt`: 用于调用 `https://right.codes/subscriptions/list` 获取额度信息
- `token`: 用于调用 `https://www.right.codes/codex/v1/responses` 的密钥（Worker 会代你转发）

可选字段（都有默认值）：
- `upstreamBaseUrl`: 默认 `https://www.right.codes`
- `upstreamResponsesPath`: 默认 `/codex/v1/responses`（RightCode 侧）
- `subscriptionListUrl`: 默认 `https://right.codes/subscriptions/list`
- `subscriptionRefreshMs`: 默认 `60000`
- `promptCacheKeyTtlMs`: routeKey→账号的粘性 TTL，默认 `3600000`
- `leaseTtlMs`: 并发 lease 超时回收，默认 `900000`
- `cooldown429Ms`: 上游返回 429 时对该账号冷却时间（ms），默认 `60000`

可选环境变量：
- `RC_BALANCE_PROXY_TOKEN`: 若配置，则所有请求必须带 `Authorization: Bearer <token>`（用于保护你的 Worker，不把右侧账号 token 暴露给调用方）
- `RC_BALANCE_EVENT_LOG_LEVEL`: D1 事件日志级别（默认 `error`）
  - `error`: 仅写入报错/切换等事件（建议生产默认）
  - `info`: 额外写入每个请求的 `request` 事件（会显著增加 D1 写入量）

## D1（订阅快照存储）

订阅额度快照会由 Cron 每分钟刷新一次，并写入 D1（共享数据库，表名带项目前缀 `rc_balance_`）。

首次使用需要创建 D1 数据库，并初始化表结构：

```bash
# 创建远程 D1 数据库（示例：general）
bunx wrangler d1 create general

# 初始化本地 D1（用于 wrangler dev）
bunx wrangler d1 execute DB --local --file=migrations/0001_rc_balance_init.sql
bunx wrangler d1 execute DB --local --file=migrations/0002_rc_balance_events.sql
bunx wrangler d1 execute DB --local --file=migrations/0003_rc_balance_events_request_body.sql
bunx wrangler d1 execute DB --local --file=migrations/0004_rc_balance_events_request_headers.sql

# 初始化远程 D1（生产/远程调试）
bunx wrangler d1 execute DB --remote --file=migrations/0001_rc_balance_init.sql
bunx wrangler d1 execute DB --remote --file=migrations/0002_rc_balance_events.sql
bunx wrangler d1 execute DB --remote --file=migrations/0003_rc_balance_events_request_body.sql
bunx wrangler d1 execute DB --remote --file=migrations/0004_rc_balance_events_request_headers.sql
```

然后把 `wrangler d1 create` 输出的 `database_id` 填入 `wrangler.toml`（本地不提交）或 `wrangler.toml.example`（示例）。

## D1（事件日志）

Worker 会把 failover/上游错误等事件异步写入 D1 表 `rc_balance_events`：
- 不会写入 token 或原始 `prompt_cache_key`（只记录 hash；`request_body` 会自动把 `prompt_cache_key` 打码）
- `detail` 可能包含上游完整错误 body（用于排查报错）
- `request_headers` 会记录请求头（自动打码 `Authorization/Cookie/prompt_cache_key` 等敏感字段）
> 如需把每个请求都写入 D1，请将 `RC_BALANCE_EVENT_LOG_LEVEL=info`（会产生较多写入与存储）。

查询示例：

```bash
# 本地
bunx wrangler d1 execute DB --local --command "SELECT ts, kind, account_label, upstream_status, route_key_hash, substr(request_headers,1,200) AS request_headers, substr(request_body,1,200) AS request_body, substr(detail,1,200) AS detail FROM rc_balance_events ORDER BY ts DESC LIMIT 50;"

# 远程
bunx wrangler d1 execute DB --remote --command "SELECT ts, kind, account_label, upstream_status, route_key_hash, substr(request_headers,1,200) AS request_headers, substr(request_body,1,200) AS request_body, substr(detail,1,200) AS detail FROM rc_balance_events ORDER BY ts DESC LIMIT 50;"
```

## 使用方式

### 1) 代理 `POST /v1/responses`

把你原本请求 `https://www.right.codes/codex/v1/responses` 的 host 换成你的 Worker 域名，并将 path 改为 `/v1/responses` 即可。

如果你设置了 `RC_BALANCE_PROXY_TOKEN`，调用时需要带：
`Authorization: Bearer <RC_BALANCE_PROXY_TOKEN>`

### 1.1) 代理 `POST /v1/chat/completions`

把你原本请求 `https://www.right.codes/codex/v1/chat/completions` 的 host 换成你的 Worker 域名，并将 path 改为 `/v1/chat/completions` 即可（支持 `stream: true`）。

### 2) `prompt_cache_key` 粘性路由

本服务的“routeKey”来源：
1. 请求体 JSON 顶层字段 `prompt_cache_key`（优先；完全透传，不注入/不改写）
2. 若请求体未提供，则尝试从请求头获取（用于兼容 Codex/VSCode 等客户端）：`Conversation_id` / `Session_id` / `prompt_cache_key`

当请求带 `prompt_cache_key` 时，路由器会执行粘性 + failover：
1. 若该 key 已绑定到某账号，且该账号 **并发未满 + 额度充足**，优先继续使用（最大化 cache hit）
2. 若该账号 **并发已满或额度不足**，选择其他可用账号并把该 key 重新绑定到新账号（后续都走新的，直到 TTL 过期或再次 failover）
3. 若上游直接返回 `401/402/403/429`（常见于 token 失效/额度不足/限流），且存在其他候选账号，会自动重试并把该 key 重新绑定到新账号（仅对“首个 HTTP 响应状态码”生效，流中途报错不处理）
4. 若上游返回 `429`，会对该账号做短暂冷却（默认 60s，可用 `cooldown429Ms` 配置），减少反复撞限流
5. 若上游返回非 SSE 的错误 JSON 且包含“余额不足”，会立刻把该账号标记为“今日不可用”（写入 D1 快照），避免后续继续选到它

服务不会在响应里暴露账号标识（例如 `label`）。

## 本地开发

```bash
bun install
cp wrangler.toml.example wrangler.toml
bun run db:migrate:local
bun run dev
```

> `wrangler dev` 运行前需要提供 `RC_BALANCE_CONFIG`（建议直接写在 `wrangler.toml` 的 `[vars]`，或用 Dashboard 配置）。

## 部署

```bash
# 确保你本地有 `wrangler.toml`（不会提交到仓库）
# 首次部署前需要先在 Cloudflare 创建 D1 数据库（`wrangler d1 create ...`），并将 `database_id` 填入 `wrangler.toml`
# 部署时会自动执行远程 D1 migrations（`wrangler d1 migrations apply`，可重复执行，未应用的才会生效）
bun run deploy
```

如果你在免费计划上使用 Durable Objects，需要在 `wrangler.toml` 的 `[[migrations]]` 中使用 `new_sqlite_classes`（而不是 `new_classes`）。
