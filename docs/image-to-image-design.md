# 图生图（Image-to-Image）技术设计

## 1. 背景

当前 Teaven AI Gateway 的图片生成能力仅支持**文生图**（Text-to-Image）：用户传入文本 prompt，上游返回生成的图片。图生图（Image-to-Image）是图片生成的常见扩展模式，用户额外提供一张或多张参考图片，结合 prompt 生成新图片。

常见图生图场景：

| 场景 | 说明 | 示例 |
| --- | --- | --- |
| 风格迁移 | 将参考图转换为指定风格 | 照片转油画、转动漫 |
| 局部重绘 | 对参考图的指定区域重新生成 | 修复人脸、替换背景 |
| 图片编辑 | 基于参考图和指令进行修改 | 换色、添加元素 |
| 超分辨率 | 基于参考图提升分辨率 | 放大、去噪 |
| 参考生成 | 以参考图为风格/内容参考生成新图 | 保持一致性生成 |

不同上游对图生图的支持程度和参数命名差异很大。平台需要在不改变对外接口统一性的前提下，扩展输入能力。

## 2. 设计目标

- 平台标准接口支持传入参考图片，兼容主流图生图上游。
- 图片输入支持 URL 和 base64 两种格式，同时支持文件上传（multipart/form-data）。
- 不改变现有文生图的调用方式——未传入图片时行为与现在完全一致。
- 图片输入经过平台统一处理后，由各 Provider Adapter 映射为上游所需格式。
- 用户上传的图片可按需转存到 R2，避免上游链接过期问题。
- 保持异步任务模型不变，图生图任务仍走 `/v1/tasks` 或 `/v1/async/images/generations`。

## 3. 对外 API 变更

### 3.1 请求参数扩展

在现有 `ImageGenerationRequest` 基础上新增图片输入字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `image` | `string \| string[]` | 否 | 参考图片。支持 URL（`https://...`）或 base64（`data:image/png;base64,...`）。传入单张图片时为字符串，多张时为数组。 |
| `mask` | `string` | 否 | 局部重绘遮罩图片，格式同 `image`。白色区域为重绘区域，黑色区域保留原图。仅对支持 inpaint 的上游生效。 |
| `strength` | `number` | 否 | 重绘强度，取值 0~1。值越大与原图差异越大，值越小越保留原图内容。默认值由上游决定。仅对支持该参数的上游生效。 |
| `mode` | `string` | 否 | 图生图模式，可选值：`image-to-image`（默认）、`inpaint`、`style-transfer`。平台据此选择处理策略，不直接透传给上游。 |

说明：

- `image` 字段的设计参考了多个上游 API 的通用模式。OpenAI 的 `images/edits` 接口使用 `image` 字段，Stability AI 使用 `init_image`，Moark/Gitee AI 使用 `reference_image`。
- `mask` 和 `strength` 是局部重绘（inpaint）的标配参数。
- `mode` 是平台层面的能力分类，帮助路由和参数校验，不直接映射到上游字段。

### 3.2 请求示例

**JSON 请求（URL 方式）：**

```http
POST /v1/tasks
Content-Type: application/json
Authorization: Bearer sk-...

{
  "type": "image.generation",
  "model": "image-model",
  "input": {
    "prompt": "将这张照片转为油画风格",
    "image": "https://example.com/input-photo.jpg",
    "strength": 0.75,
    "width": 1024,
    "height": 1024
  }
}
```

**JSON 请求（base64 方式）：**

```http
POST /v1/tasks
Content-Type: application/json
Authorization: Bearer sk-...

{
  "type": "image.generation",
  "model": "image-model",
  "input": {
    "prompt": "在天空中添加彩虹",
    "image": "data:image/png;base64,iVBORw0KGgo...",
    "mask": "data:image/png;base64,iVBORw0KGgo...",
    "mode": "inpaint",
    "width": 1024,
    "height": 1024
  }
}
```

**Multipart 文件上传：**

```http
POST /v1/tasks
Content-Type: multipart/form-data; boundary=----formdata
Authorization: Bearer sk-...

------formdata
Content-Disposition: form-data; name="metadata"

{"type":"image.generation","model":"image-model","input":{"prompt":"转为动漫风格","strength":0.8}}
------formdata
Content-Disposition: form-data; name="image"; filename="photo.jpg"
Content-Type: image/jpeg

<binary data>
------formdata
Content-Disposition: form-data; name="mask"; filename="mask.png"
Content-Type: image/png

<binary data>
------formdata--
```

### 3.3 图片模型平台标准参数（更新）

完整参数列表（包含已有和新增）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | `string` | 必填 | 提示词 |
| `image` | `string \| string[]` | 无 | 参考图片（URL 或 base64） |
| `mask` | `string` | 无 | 局部重绘遮罩 |
| `strength` | `number` | 上游默认 | 重绘强度 0~1 |
| `mode` | `string` | `image-to-image` | 图生图模式 |
| `width` | `number` | `1024` | 图片宽度（像素）。与 `aspect_ratio` 互斥 |
| `height` | `number` | `1024` | 图片高度（像素）。与 `aspect_ratio` 互斥 |
| `aspect_ratio` | `string` | 无 | 图片比例，如 `"1:1"`、`"16:9"`、`"9:16"`。网关自动从模型支持的尺寸列表中匹配。与 `width`/`height` 互斥 |
| `quality` | `string` | 无 | 图片画质，如 `"standard"`、`"hd"`。网关自动从模型支持的尺寸列表中匹配。可与 `aspect_ratio` 组合使用 |
| `image_count` | `number` | `1` | 生成数量 |
| `steps` | `number` | `30` | 采样步数 |
| `guidance_scale` | `number` | `1.0` | 引导强度 |
| `negative_prompt` | `string` | `""` | 反向提示词 |
| `seed` | `number` | 无 | 随机种子 |
| `response_format` | `string` | `url` | 返回格式 |
| `style` | `string` | 无 | 图片风格 |
| `provider_params` | `object` | 无 | 上游原生参数透传 |

### 3.4 Provider 参数映射（新增）

| 平台标准字段 | `openai-compatible` 上游字段 | `moark-async` 上游字段 |
| --- | --- | --- |
| `image` | `image`（OpenAI edits 接口） | `reference_image` |
| `mask` | `mask`（OpenAI edits 接口） | `mask_image` |
| `strength` | `strength` | `strength` |
| `mode` | 不直接映射，用于平台路由决策 | 不直接映射 |

说明：

- OpenAI 的 `images/edits` 接口要求图片以 multipart/form-data 上传，平台 Adapter 需要将 URL/base64 转换为文件流后重新编码上传。
- Moark/Gitee AI 支持在 JSON body 中传入图片 URL 或 base64。
- 对于不支持图生图的上游，平台应返回明确错误，而不是静默忽略图片参数。

## 4. 类型定义变更

### 4.1 `src/types.ts`

`ImageGenerationRequest` 新增字段：

```typescript
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  // ── 图生图字段 ──
  image?: string | string[];       // 参考图片 URL 或 base64
  mask?: string;                    // 局部重绘遮罩
  strength?: number;                // 重绘强度 0~1
  mode?: "image-to-image" | "inpaint" | "style-transfer"; // 图生图模式
  // ── 已有字段 ──
  image_count?: number;
  n?: number;
  size?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance_scale?: number;
  negative_prompt?: string;
  seed?: number;
  response_format?: "url" | "b64_json";
  quality?: string;
  style?: string;
  provider_params?: Record<string, unknown>;
  [key: string]: unknown;
}
```

新增类型：

```typescript
/**
 * 图片输入的标准化形式。
 * 平台统一将 URL / base64 / 文件上传解析为 ImageInput。
 */
export interface ImageInput {
  /** 图片来源类型 */
  source: "url" | "base64" | "r2";
  /** URL 地址（source=url 或 source=r2 时有值） */
  url?: string;
  /** base64 数据（source=base64 时有值） */
  data?: string;
  /** MIME 类型，例如 image/png、image/jpeg */
  mime_type?: string;
  /** R2 对象键（source=r2 时有值） */
  r2_key?: string;
}
```

### 4.2 `src/providers/types.ts`

`ProviderAdapter` 接口无需变更——`imageGenerations` 方法已经接收 `ImageGenerationRequest`，扩展字段自然流入。

`ProviderCapability` 新增能力声明：

```typescript
export interface ProviderCapability {
  execution_mode: ExecutionMode;
  supports_stream?: boolean;
  result_delivery?: "direct" | "polling" | "webhook";
  poll_interval_seconds?: number;
  parameters?: ProviderParameterSpec[];
  // ── 新增 ──
  supports_image_input?: boolean;   // 是否支持图生图
  supports_mask?: boolean;          // 是否支持局部重绘
  supports_strength?: boolean;      // 是否支持重绘强度
  supported_image_modes?: string[]; // 支持的图生图模式列表
}
```

## 5. 请求解析变更

### 5.1 `src/utils/request.ts`

新增 `readMultipartRequest` 函数，支持 `multipart/form-data` 请求：

```typescript
export interface MultipartParseResult {
  /** 表单文本字段（JSON 字符串或普通文本） */
  fields: Record<string, string>;
  /** 文件字段 */
  files: Record<string, MultipartFile>;
}

export interface MultipartFile {
  name: string;
  type: string;
  data: ArrayBuffer;
}

/**
 * 解析 multipart/form-data 请求。
 * 支持文件上传场景（图生图的图片上传）。
 */
export async function readMultipartRequest(request: Request): Promise<MultipartParseResult>
```

新增 `resolveImageInput` 工具函数，将各种图片输入格式统一为 `ImageInput`：

```typescript
/**
 * 将用户传入的图片值（URL、base64、文件）解析为标准 ImageInput。
 * - URL（https://...）→ source: "url"
 * - base64（data:image/...;base64,...）→ source: "base64"
 * - 已转存到 R2 → source: "r2"
 */
export function resolveImageInput(value: unknown, env: Env): ImageInput | undefined
```

### 5.2 文件上传转存流程

当用户通过 multipart/form-data 上传图片文件时：

1. `readMultipartRequest` 解析出文件二进制数据。
2. 将文件写入 R2，路径为 `inputs/{task_id}/{random_id}.{ext}`。
3. 生成 R2 对象键作为 `ImageInput.r2_key`。
4. 后续 Provider Adapter 根据需要将 R2 文件下载后转发给上游，或生成签名 URL 供上游拉取。
5. 输入文件的 TTL 与任务输出文件一致（默认 24 小时），到期删除。

## 6. Provider Adapter 变更

### 6.1 `openai-compatible` 插件

OpenAI 的图片编辑接口（`/v1/images/edits`）使用 `multipart/form-data` 上传图片和遮罩。Adapter 需要：

1. 检测到 `image` 参数时，将请求模式从 `/v1/images/generations` 切换到 `/v1/images/edits`。
2. 将 `image` 和 `mask`（URL 或 base64）下载/解码为二进制。
3. 构造 `multipart/form-data` 请求体，包含 `image`、`mask`、`prompt`、`size`、`n` 等字段。
4. 发送到上游。

关键变更位置：`src/providers/openai-compatible.ts` 的 `forwardImageGeneration` 函数。

```typescript
async function forwardImageGeneration(
  request: ImageGenerationRequest,
  context: ProviderRequestContext
): Promise<Response> {
  const hasImageInput = request.image || request.mask;

  if (hasImageInput) {
    return forwardImageEdit(request, context);  // 新增
  }

  // 已有文生图逻辑不变
  return forwardTextToImage(request, context);
}
```

新增 `forwardImageEdit` 函数：

```typescript
async function forwardImageEdit(
  request: ImageGenerationRequest,
  context: ProviderRequestContext
): Promise<Response> {
  const apiKey = context.credential.api_key;
  if (!apiKey) {
    throw upstreamError("Provider API key is missing", 503, "provider_unavailable");
  }

  const baseUrl = context.credential.base_url || "https://api.openai.com/v1";
  const upstreamUrl = joinUrl(baseUrl, "/images/edits");

  // 构造 multipart/form-data
  const formData = new FormData();
  formData.append("model", context.route.provider_model);
  formData.append("prompt", request.prompt);

  // 下载/解码图片并附加
  const imageBlob = await resolveToBlob(request.image);
  formData.append("image", imageBlob, "image.png");

  if (request.mask) {
    const maskBlob = await resolveToBlob(request.mask);
    formData.append("mask", maskBlob, "mask.png");
  }

  if (request.size) formData.append("size", request.size);
  if (request.n || request.image_count) {
    formData.append("n", String(request.n || request.image_count || 1));
  }
  if (request.response_format) formData.append("response_format", request.response_format);

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Request-Id": context.request_id
    },
    body: formData,
    signal: context.signal
  });

  if (!upstream.ok) {
    throw await mapUpstreamError(upstream);
  }

  const data = await upstream.json();
  return jsonResponse(data, {
    status: 200,
    headers: { "X-Request-Id": context.request_id }
  });
}
```

新增 `resolveToBlob` 辅助函数：

```typescript
/**
 * 将图片输入（URL 或 base64）解析为 Blob。
 * - URL → fetch 下载
 * - data URI → 解码 base64
 */
async function resolveToBlob(input: string): Promise<Blob>
```

### 6.2 `moark-async` 插件

Moark/Gitee AI 的图生图参数直接在 JSON body 中传入。Adapter 需要：

1. 在 `buildMoarkImageRequest` 中检测 `image` 参数。
2. 将 `image` 映射为 `reference_image`。
3. 将 `mask` 映射为 `mask_image`。
4. 将 `strength` 直接透传。
5. 如果上游不支持图生图的模型，需要在创建阶段就返回明确错误。

关键变更位置：`src/providers/moark-async.ts` 的 `buildMoarkImageRequest` 函数。

```typescript
function buildMoarkImageRequest(
  request: ImageGenerationRequest,
  providerModel: string
): Record<string, unknown> {
  const providerParams = objectParam(request.provider_params);
  const upstreamRequest: Record<string, unknown> = {
    // ... 已有字段 ...
  };

  // ── 图生图参数映射 ──
  if (request.image) {
    upstreamRequest.reference_image = normalizeImageForUpstream(request.image);
  }
  if (request.mask) {
    upstreamRequest.mask_image = normalizeImageForUpstream(request.mask);
  }
  if (typeof request.strength === "number") {
    upstreamRequest.strength = request.strength;
  }

  // ... 已有清理逻辑 ...
  return upstreamRequest;
}
```

新增 `normalizeImageForUpstream` 辅助函数：

```typescript
/**
 * 将平台 ImageInput 格式转换为上游可接受的格式。
 * - URL → 直接传递 URL
 * - base64 → 传递完整 data URI
 * - r2_key → 生成签名 URL 或下载后转 base64
 */
function normalizeImageForUpstream(image: string | string[]): string | string[]
```

### 6.3 Manifest 能力声明更新

两个插件的 manifest 需要更新能力声明：

**`openai-compatible`：**

```typescript
"image": {
  execution_mode: "sync",
  supports_image_input: true,
  supports_mask: true,
  supports_strength: true,
  supported_image_modes: ["image-to-image", "inpaint"],
  parameters: [
    // ... 已有参数 ...
    { name: "image", type: "string", description: "参考图片 URL 或 base64", maps_to: "image" },
    { name: "mask", type: "string", description: "局部重绘遮罩", maps_to: "mask" },
    { name: "strength", type: "number", description: "重绘强度 0~1", maps_to: "strength" }
  ]
}
```

**`moark-async`：**

```typescript
"image": {
  execution_mode: "async_polling",
  result_delivery: "polling",
  poll_interval_seconds: 2,
  supports_image_input: true,
  supports_mask: true,
  supports_strength: true,
  supported_image_modes: ["image-to-image", "inpaint"],
  parameters: [
    // ... 已有参数 ...
    { name: "image", type: "string", description: "参考图片 URL 或 base64", maps_to: "reference_image" },
    { name: "mask", type: "string", description: "局部重绘遮罩", maps_to: "mask_image" },
    { name: "strength", type: "number", description: "重绘强度 0~1", maps_to: "strength" }
  ]
}
```

## 7. 路由和任务处理变更

### 7.1 任务类型

图生图任务的 `type` 仍为 `"image"`，不需要引入新的任务类型。平台通过 `input` 中是否包含 `image` 字段来区分文生图和图生图。

### 7.2 路由层变更

路由层 (`src/routes/async-image-generations.ts`, `src/routes/tasks.ts`) 需要：

1. 支持解析 `image`、`mask`、`strength`、`mode` 字段。
2. 如果请求包含 multipart/form-data，先解析表单，将文件转存到 R2，再构造标准 `ImageGenerationRequest`。
3. 校验图片输入的合法性：
   - `image` 字段必须是有效 URL 或合法 base64 data URI。
   - `mask` 仅在 `mode` 为 `inpaint` 时有意义，但仍允许传入（由上游决定是否使用）。
   - `strength` 必须在 0~1 范围内。
4. 校验上游是否支持图生图：如果 Provider Capability 声明 `supports_image_input: false`，返回 `400` 错误。

### 7.3 任务处理器变更

`src/tasks/processor.ts` 的 `createUpstreamTask` 函数需要确保图片输入字段正确传递到 Adapter。当前的 `reqBody` 构造逻辑已经使用 `...(task.input as Record<string, unknown>)`，新增字段会自动流入，无需额外处理。

### 7.4 输入文件存储

用户通过文件上传方式提交的图片需要转存到 R2：

| 阶段 | 行为 |
| --- | --- |
| 请求进入 | multipart 文件写入 R2 `inputs/{task_id}/{random_id}.{ext}` |
| 任务创建 | `input.image` 和 `input.mask` 记录 R2 对象键 |
| 上游调用 | Adapter 从 R2 读取文件或生成签名 URL |
| 任务完成 | 输入文件跟随任务 TTL 一起过期清理 |

## 8. 数据库变更

无需修改数据库 schema。`async_tasks.input` 字段已经是 `TEXT` 类型存储 JSON，新增的图片输入字段自然包含在 JSON 中。

示例任务 `input`：

```json
{
  "prompt": "转为油画风格",
  "image": "https://example.com/photo.jpg",
  "strength": 0.75,
  "width": 1024,
  "height": 1024,
  "image_count": 1
}
```

文件上传场景下，`image` 存储 R2 对象键：

```json
{
  "prompt": "转为油画风格",
  "image": "inputs/task_xxx/abc123.jpg",
  "image_source": "r2",
  "strength": 0.75,
  "width": 1024,
  "height": 1024
}
```

## 9. 安全和限制

### 9.1 文件大小限制

- 单张图片最大 20MB。
- multipart 请求总大小最大 50MB。
- 超出限制返回 `413 Payload Too Large`。

### 9.2 图片格式支持

支持的图片格式：`image/png`、`image/jpeg`、`image/webp`、`image/gif`（静态）。

不支持的格式返回 `400` 错误，明确告知用户支持的格式列表。

### 9.3 base64 大小限制

base64 编码的图片数据最大 30MB（编码后约 40MB），等同于 20MB 原始文件。

### 9.4 输入文件生命周期

- 用户上传的输入文件存储在 R2 `inputs/` 前缀下。
- TTL 与任务 `storage_ttl_seconds` 一致，默认 86400 秒。
- 到期后由 Cron Worker 或 R2 生命周期规则清理。
- 输入文件不对外暴露下载接口，仅平台内部使用。

### 9.5 上游兼容性检查

- 如果用户传入了 `image` 参数，但目标模型的 Provider 声明 `supports_image_input: false`，返回明确错误：
  ```json
  {
    "error": {
      "message": "Model does not support image-to-image: image-model",
      "type": "invalid_request_error",
      "param": "image",
      "code": "unsupported_image_input"
    }
  }
  ```
- 不会静默忽略图片参数，避免用户误以为图生图已生效。

## 10. 实施计划

### 阶段一：类型和请求解析

1. 更新 `src/types.ts`：`ImageGenerationRequest` 新增 `image`、`mask`、`strength`、`mode` 字段。
2. 新增 `ImageInput` 类型。
3. 更新 `src/utils/request.ts`：新增 `readMultipartRequest` 和 `resolveImageInput`。
4. 更新 `src/providers/types.ts`：`ProviderCapability` 新增 `supports_image_input`、`supports_mask`、`supports_strength`。

### 阶段二：Provider 适配

5. 更新 `src/providers/openai-compatible.ts`：
   - Manifest 声明图生图能力。
   - 新增 `forwardImageEdit` 函数。
   - 新增 `resolveToBlob` 辅助函数。
6. 更新 `src/providers/moark-async.ts`：
   - Manifest 声明图生图能力。
   - `buildMoarkImageRequest` 新增图片参数映射。
   - 新增 `normalizeImageForUpstream` 辅助函数。

### 阶段三：路由和任务处理

7. 更新 `src/routes/async-image-generations.ts`：支持 multipart 请求和图片参数校验。
8. 更新 `src/routes/tasks.ts`：通用任务创建支持图片输入。
9. 更新 `src/routes/image-generations.ts`：同步图片生成接口支持图生图。
10. 更新 `src/tasks/processor.ts`：确保图片输入在创建上游任务时正确传递。

### 阶段四：文件处理和清理

11. 新增输入文件转存逻辑：multipart 上传的文件写入 R2。
12. 更新 Cron Worker：输入文件过期清理。
13. 更新 `src/tasks/output.ts`：支持输入文件的 URL 解析。

### 阶段五：文档和测试

14. 更新 `README.md` 和 `docs/technical-design.md`：补充图生图相关文档。
15. 更新 `docs/provider-plugin-guide.md`：说明插件如何声明和实现图生图能力。
16. 编写端到端测试用例。

## 11. 待确认问题

- Moark/Gitee AI 的具体图生图 API 参数格式是否需要进一步确认？文档中 `reference_image`、`mask_image` 等字段名是否准确？
- OpenAI 的 `images/edits` 接口是否为所有兼容上游都支持？部分 OpenAI 兼容上游可能不支持 edits 接口，是否需要 fallback 到 generations？
- 是否需要支持 ControlNet 等高级控制方式？当前设计暂不覆盖。
- 输入文件是否需要在用户中心展示？当前设计仅在任务详情中展示。
- 是否需要对图生图任务单独计费（例如更高的媒体单位）？
