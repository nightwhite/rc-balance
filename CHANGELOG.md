# Changelog

本文件记录项目所有重要变更。  
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-01-02

### 新增
- Cloudflare Workers 代理入口 `POST /v1/responses`（SSE 透传）
- 多账号路由：并发限制、`prompt_cache_key`/会话 header 粘性、failover
- 订阅额度快照（Cron 刷新写入 D1）
- 错误事件日志（写入 D1 `rc_balance_events`）

