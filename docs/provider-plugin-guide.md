# Provider 插件开发指南

Provider Plugin 用于把任意上游模型服务接入 Teaven AI Gateway。平台核心只识别统一接口，不关心上游是 OpenAI 兼容、同步接口、异步接口、轮询接口、回调接口还是私有协议。

Provider Plugin 只描述一类协议或供应商适配能力，不等同于一个具体上游账号。具体 endpoint、区域、凭证和运行状态应配置成上游实例，再由模型路由引用该上游实例。

## 1. 插件目标

新增一个上游时，应只新增或启用 Provider Plugin，不改变：

- 对外 API。
- 任务状态机。
- 错误格式。
- usage 格式。
- 文件转存规则。
- 计费和限流流程。

插件负责把上游差异归一到平台标准对象。

## 2. 插件形态

| 形态 | 说明 |
| --- | --- |
| Built-in Plugin | 官方内置插件，随平台发布。 |
| Private Plugin | 私有部署时加入仓库并随 Worker 构建。 |
| Remote Plugin | 外部 HTTP 适配服务，平台通过签名请求调用。 |

MVP 优先支持 Built-in Plugin 和 Private Plugin。Remote Plugin 后续用于无需重新部署核心 Worker 的扩展场景。

## 3. 插件组成

一个插件至少包含：

- `manifest`：插件 ID、名称、版本、运行方式、能力声明、配置 schema。
- `adapter`：协议转换实现。
- `credential_schema`：密钥和非密钥配置定义。
- `capabilities`：文本、图片、视频、文件等能力和执行模式。
- `mapping`：状态、错误、usage、文件输出映射规则。

插件和上游实例的边界：

| 对象 | 职责 | 示例 |
| --- | --- | --- |
| Provider Plugin | 实现协议转换和能力声明。 | `openai-compatible` |
| Upstream | 绑定插件、endpoint、凭证、区域和健康状态。 | `siliconflow-cn` |
| Model Route | 把平台模型别名路由到上游实例和真实模型名。 | `deepseek-chat` -> `siliconflow-cn` / `deepseek-ai/DeepSeek-V3` |

## 4. Manifest 示例

```json
{
  "id": "example-provider",
  "name": "Example Provider",
  "version": "1.0.0",
  "runtime": "in_process",
  "credential_schema": {
    "api_key": { "type": "secret", "required": true },
    "base_url": { "type": "string", "required": false }
  },
  "capabilities": {
    "chat.completions": {
      "execution_mode": "stream_or_sync",
      "supports_stream": true
    },
    "image.generation": {
      "execution_mode": "async_polling",
      "result_delivery": "polling",
      "poll_interval_seconds": 5
    }
  }
}
```

Manifest 不存储密钥明文，只描述需要哪些配置。密钥使用 Cloudflare secrets、加密存储或受控 secret 引用。

## 5. Adapter 合约

Adapter 建议实现以下能力：

| 方法 | 必需 | 说明 |
| --- | --- | --- |
| `capabilities` | 是 | 返回能力和执行模式。 |
| `buildRequest` | 文本必需 | 将平台文本请求转换为上游请求。 |
| `parseResponse` | 文本必需 | 将上游非流式响应转换为 OpenAI 兼容响应。 |
| `parseStream` | 流式必需 | 将上游流转换为 OpenAI 兼容 SSE chunk。 |
| `createTask` | 异步上游必需 | 创建上游异步任务。 |
| `executeSyncTask` | 同步媒体上游必需 | 后台调用同步型上游接口。 |
| `getTask` | 轮询上游必需 | 查询上游异步任务状态。 |
| `cancelTask` | 可选 | 取消上游任务。 |
| `normalizeTaskResult` | 任务必需 | 转换图片、视频、文件输出。 |
| `mapError` | 是 | 转换为平台统一错误。 |
| `extractUsage` | 是 | 提取或估算 usage。 |
| `verifyWebhook` | 回调上游必需 | 校验上游 webhook。 |
| `healthCheck` | 可选 | 校验凭证和 endpoint 可用性。 |

## 6. 执行模式

插件需要声明每个能力的执行模式：

| execution_mode | 说明 |
| --- | --- |
| `sync` | 上游同步返回完整结果。 |
| `stream` | 上游只支持流式。 |
| `stream_or_sync` | 上游同时支持流式和非流式。 |
| `async_polling` | 上游创建任务后需要轮询。 |
| `async_webhook` | 上游创建任务后通过 webhook 回调。 |

平台根据执行模式选择内部流程，但对外接口保持不变。

## 7. 文件输出规则

插件返回文件结果时必须标明来源和内容形态：

| 上游结果 | 插件输出 | 平台处理 |
| --- | --- | --- |
| URL | `source: upstream_url` | 默认直接返回上游 URL。 |
| URL + 用户要求转存 | `source: upstream_url` | 平台下载到 R2。 |
| base64 | `source: base64` | 平台强制转存到 R2。 |
| binary | `source: binary` | 平台强制转存到 R2。 |

R2 文件默认保存 24 小时，受 `storage_ttl_seconds` 控制，最大 24 小时。

## 8. 新增上游流程

1. 确认上游协议。如果已有插件能覆盖，例如 OpenAI 兼容协议，直接复用插件。
2. 如协议未覆盖，创建 Provider Plugin，编写 Manifest 并实现 Adapter 合约。
3. 添加状态、错误、usage 和文件输出映射。
4. 注册插件到 Provider Registry。
5. 配置上游实例，写入 `plugin_id`、协议参数、endpoint、区域和凭证引用。
6. 执行上游实例的 `healthCheck`。
7. 配置模型别名和路由，路由目标使用 `upstream_id + provider_model`。
8. 用文本流式、非流式、异步任务、错误场景做回归测试。

## 9. Remote Plugin 要求

Remote Plugin 必须遵守同一标准输入输出协议，并满足：

- 平台到 Remote Plugin 的请求必须签名。
- Remote Plugin 响应必须有超时限制。
- 平台必须对 Remote Plugin 做熔断和重试上限控制。
- Remote Plugin 只能拿到当前请求所需的最小凭证和上下文。
- Remote Plugin 不得接收用户 API Key 明文、租户余额或完整账本信息。
