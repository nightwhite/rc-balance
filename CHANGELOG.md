# Changelog

本文件记录项目所有重要变更。  
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- D1 事件表 `rc_balance_events` 新增 `request_body`/`request_headers` 字段（自动打码敏感信息），并记录上游完整错误 body 到 `detail`
- 新增 `RC_BALANCE_EVENT_LOG_LEVEL`：`info` 时每个请求写入 D1（`kind=request`），`error` 时仅记录错误/切换事件
- 调整 `/v1/responses` 的 `instructions` 兼容策略：`instructions` 包含 `Codex CLI` 时不注入 `input` 且不删除（首发透传）；若上游返回 `Instructions are not valid/required`，自动重试一次（移除 `instructions` 后转发）

## [0.1.0] - 2026-01-02

### 新增
- Cloudflare Workers 代理入口 `POST /v1/responses`（SSE 透传）
- 多账号路由：并发限制、`prompt_cache_key`/会话 header 粘性、failover
- 订阅额度快照（Cron 刷新写入 D1）
- 错误事件日志（写入 D1 `rc_balance_events`）
