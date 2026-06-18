# Teaven AI Gateway - 项目记忆

## 架构决策

### protocol_type 已移除，plugin 改为"类型"下拉（2026-06-15）
- `protocol_type` 字段已从 `UpstreamConfig` 和 `ProviderRouteConfig` 中完全移除。
- 原因：`protocol_type` 和 `plugin_id` 重复 —— 每个 Provider Plugin 本身就定义了它能处理的协议类型。
- 运行时仅使用 `plugin_id` 通过 ProviderRegistry 查找适配器。
- 管理后台：标签从"Provider Plugin"改为"类型"，输入从文本框改为从已注册插件列表动态填充的下拉选择框，表格列标题从"插件"改为"类型"。
- 表格中 `plugin_id` 展示已改为显示插件名称（从 providers 数据匹配），dashboard 和模型路由同理。
- 所有文档已同步更新。

### 异步任务生命周期追踪（2026-06-18）
- Queue Consumer 已实现：`src/index.ts` 导出 `queue()` handler，核心逻辑在 `src/tasks/processor.ts`
- Provider Adapter 新增 `pollTask` 方法，Moark 已实现
- 任务创建时存储完整 `provider_context`（base_url, credential_id, config），Consumer 据此重建凭据
- 状态变迁：queued → running → (轮询) → succeeded/failed/expired
- 最多轮询 300 次，超限标记 expired；上游 4xx → 永久失败，5xx → 继续重试
- store_output=true 时自动下载上游文件存到 R2
- callback_url 在任务终态时触发 POST 回调

## 项目技术栈
- Cloudflare Workers + D1 + KV + R2 + Queues
- TypeScript 5.8+, Wrangler 4
- 插件化 Provider 架构
