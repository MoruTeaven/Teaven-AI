# Teaven AI Gateway - 项目记忆

## 架构决策

### protocol_type 已移除，plugin 改为"类型"下拉（2026-06-15）
- `protocol_type` 字段已从 `UpstreamConfig` 和 `ProviderRouteConfig` 中完全移除。
- 原因：`protocol_type` 和 `plugin_id` 重复 —— 每个 Provider Plugin 本身就定义了它能处理的协议类型。
- 运行时仅使用 `plugin_id` 通过 ProviderRegistry 查找适配器。
- 管理后台：标签从"Provider Plugin"改为"类型"，输入从文本框改为从已注册插件列表动态填充的下拉选择框，表格列标题从"插件"改为"类型"。
- 表格中 `plugin_id` 展示已改为显示插件名称（从 providers 数据匹配），dashboard 和模型路由同理。
- 所有文档已同步更新。

## 项目技术栈
- Cloudflare Workers + D1 + KV + R2 + Queues
- TypeScript 5.8+, Wrangler 4
- 插件化 Provider 架构
