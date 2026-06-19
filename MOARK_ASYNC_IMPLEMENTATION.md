# 模力方舟异步接口适配说明

本文档说明了如何将 Teaven AI Gateway 适配模力方舟（Gitee AI）的异步图像生成接口。

## 核心改动

### 1. 新增 Provider Plugin：`moark-async`
- 文件: `src/providers/moark-async.ts`
- 功能: 适配模力方舟异步图像生成接口 `POST /image_generation`
- 执行模式: `async_polling` - 异步轮询模式
- 特点:
  - 接收异步请求并返回 `task_id`
  - 支持上游 API Key 鉴权
  - 错误映射到统一的网关错误格式

### 2. 更新类型系统
- 文件: `src/types.ts`, `src/providers/types.ts`
- 改动:
  - 添加 `supports_async` 字段到 `UpstreamModelConfig`、`ProviderRouteConfig` 和 `ModelConfig`
  - 新增 `AsyncTaskResponse` 接口用于异步响应

### 3. 新增异步图像生成路由处理器
- 文件: `src/routes/async-image-generations.ts`
- 端点: `POST /v1/async/images/generations`
- 处理流程:
  1. 验证请求参数（模型、提示词等）
  2. 权限检查（API Key 能否访问此模型）
  3. 调用上游异步接口
  4. 创建本地任务记录
  5. 返回 `202 Accepted` 和 `task_id`
  6. 将任务加入异步队列进行轮询

### 4. 路由配置更新
- 文件: `src/index.ts`, `src/providers/registry.ts`, `src/config.ts`
- 改动:
  - 注册 `moark-async` Provider Plugin
  - 添加 `POST /v1/async/images/generations` 路由处理
  - 支持配置中的 `supports_async` 属性传播

### 5. 文档更新
- 文件: `docs/configuration.md`
- 内容: 
  - 模力方舟异步接口的完整配置指南
  - 请求/响应示例
  - 环境变量配置说明

## 使用配置示例

在 `MODEL_CONFIG_JSON` 中添加模力方舟异步模型：

```json
{
  "upstreams": [
    {
      "id": "moark-image-gen",
      "name": "Moark Async Image Generation",
      "plugin_id": "moark-async",
      "base_url": "https://ai.gitee.com/api/v1",
      "credential_id": "env:MOARK_API_KEY",
      "status": "active",
      "models": [
        {
          "alias": "Qwen-Image",
          "provider_model": "Qwen-Image",
          "modality": "image",
          "supports_async": true,
          "priority": 1,
          "weight": 100,
          "status": "active"
        }
      ]
    }
  ]
}
```

## 请求流程

### 用户请求
```
POST /v1/async/images/generations HTTP/1.1
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "model": "Qwen-Image",
  "prompt": "A beautiful sunset over mountains",
  "n": 1,
  "size": "1024x1024"
}
```

### 网关响应（202 Accepted）
```json
{
  "id": "task_abc123def456",
  "object": "task",
  "type": "image_generation",
  "status": "queued",
  "created_at": "2026-06-16T15:30:00Z",
  "updated_at": "2026-06-16T15:30:00Z"
}
```

### 查询任务结果
```
GET /v1/tasks/task_abc123def456 HTTP/1.1
Authorization: Bearer {api_key}
```

## 关键特性

1. 异步执行: 返回 `202 Accepted`，客户端可立即获得 `task_id` 进行查询
2. 后台轮询: 网关通过异步队列持续轮询上游任务状态
3. 统一接口: 无论上游支持何种协议，用户始终使用网关统一定义的任务接口
4. 错误映射: 将模力方舟特定错误映射到网关标准错误格式
5. 权限控制: 支持按 API Key 限制可访问的模型

## 文件清单

| 文件 | 用途 |
| --- | --- |
| src/providers/moark-async.ts | 模力方舟异步 Provider 实现 |
| src/routes/async-image-generations.ts | 异步图像生成路由处理 |
| src/providers/types.ts | 新增 AsyncTaskResponse 接口 |
| src/types.ts | 新增 supports_async 字段 |
| src/index.ts | 新增路由处理 |
| src/providers/registry.ts | 注册 moark-async 插件 |
| src/config.ts | 支持 supports_async 字段处理 |
| docs/configuration.md | 配置文档更新 |

## 后续工作

1. 任务轮询实现: 需要在异步队列消费端实现对上游任务的轮询逻辑
2. 结果存储: 需要实现任务结果的 R2 存储和过期管理
3. webhook 支持: 可扩展支持模力方舟的 webhook 回调模式
4. 其他上游: 可按类似模式适配其他异步服务商（如硅基流动异步接口）
5. 错误恢复: 完善超时、重试和失败处理机制

## 编译验证

所有改动已通过 TypeScript 类型检查：

```bash
npm run typecheck
# 通过，无类型错误
```
