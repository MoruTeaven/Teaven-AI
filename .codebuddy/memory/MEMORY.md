# Teaven AI Gateway - 项目记忆

## 架构决策

### protocol_type 已移除（2026-06-15）
- `protocol_type` 字段已从 `UpstreamConfig` 和 `ProviderRouteConfig` 中完全移除。
- 原因：`protocol_type` 和 `plugin_id` 重复 —— 每个 Provider Plugin 本身就定义了它能处理的协议类型，不需要额外的协议标签字段。
- 运行时仅使用 `plugin_id` 通过 ProviderRegistry 查找适配器，`protocol_type` 从未在运行时被使用。
- 管理后台 UI 中"协议类型"下拉框已移除，"协议"列标题改为"插件"，展示 `plugin_id` 替代原来的 `protocol_type`。
- 所有文档（README.md、docs/configuration.md、docs/technical-design.md）已同步更新。

## 项目技术栈
- Cloudflare Workers + D1 + KV + R2 + Queues
- TypeScript 5.8+, Wrangler 4
- 插件化 Provider 架构
