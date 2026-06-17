# 方舟AI图像生成客户端

优化的异步接口实现，支持错误处理、日志记录和会话管理。

## 关键改进

### 1. **API 404 问题修复**
- 提供了多个可能的API端点选项
- 添加了详细的错误日志，显示端点URL和认证问题

**尝试以下端点：**
```
https://ai.gitee.com/api/v1/image_generation
https://ai.gitee.com/v1/images/generations
https://ai.gitee.com/v1/async/images/generations  (原始)
```

### 2. **重试机制**
- 请求级别：3次重试，指数退避
- 网络错误自动恢复
- 避免因瞬时故障导致任务失败

### 3. **改进的轮询逻辑**
```python
# 状态机清晰化：成功/失败/取消直接返回，其他状态继续轮询
if status == "success":
    return handle_success()
elif status in ["failed", "cancelled"]:
    return result
else:
    time.sleep(retry_interval)
    continue  # 下一轮
```

### 4. **日志系统**
- 结构化日志（INFO/WARNING/ERROR）
- 包含时间戳和日志级别
- 故障排查时显示详细信息

### 5. **配置管理**
```python
config = ImageGenerationConfig(
    api_url="https://ai.gitee.com/api/v1/image_generation",
    api_token="your_token",
    timeout=30*60,           # 30分钟超时
    retry_interval=5,        # 5秒轮询间隔
    max_retries=3           # 单个请求最多重试3次
)
```

## 使用示例

### 基础使用
```python
from image_generation_client import ArksImageClient, ImageGenerationConfig

config = ImageGenerationConfig(
    api_url="https://ai.gitee.com/api/v1/image_generation",
    api_token="YOUR_API_TOKEN"
)

client = ArksImageClient(config)

try:
    task_id = client.submit_task(
        prompt="你的图像描述",
        model="Qwen-Image",
        size="1024x1024"
    )
    
    result = client.poll_task(task_id, open_browser=True)
    print(f"任务状态: {result['status']}")
    
finally:
    client.close()
```

### 高级配置
```python
config = ImageGenerationConfig(
    api_url="https://ai.gitee.com/api/v1/image_generation",
    api_token="YOUR_API_TOKEN",
    timeout=60*60,      # 1小时超时
    retry_interval=10,  # 10秒轮询间隔
    max_retries=5       # 最多重试5次
)
```

## 故障排查

### 404错误
```
❌ HTTP错误 404
API端点不存在。请检查:
  - API URL: https://ai.gitee.com/api/v1/image_generation
  - API令牌是否有效
  - 方舟模型服务是否在线
```

**解决方案：**
1. 确认API URL正确（可能需要调整路径）
2. 验证API Token是否过期或无效
3. 检查网络连接和代理设置

### 超时
```
⏰ 达到最大轮询次数 (360)
```

**解决方案：**
1. 增加 `config.timeout` 值
2. 检查任务是否卡住（查看 `task_*.json` 文件）
3. 考虑服务器性能

### 网络错误
代码会自动重试3次，使用指数退避：
- 第1次重试：等待2秒
- 第2次重试：等待4秒
- 第3次重试后失败

## 参数说明

### 图像生成参数
- `prompt`: 图像描述（必需）
- `model`: 模型名称（默认: Qwen-Image）
- `size`: 图像尺寸（默认: 1024x1024，格式: "WIDTHxHEIGHT"）
- `num_images_per_prompt`: 生成数量（默认: 1）
- `num_inference_steps`: 推理步数（默认: 4，范围: 1-50）
- `cfg_scale`: 引导尺度（默认: 1.0）
- `negative_prompt`: 反面提示
- `seed`: 随机种子（可选）
- `lora_weights`: LoRA权重（可选）

## 输出文件

任务结果自动保存为 `task_{task_id}.json`，包含：
- 任务状态
- 生成时间
- 输出URL或文本结果
- 完整的响应元数据

## 依赖
```
requests>=2.28.0
```

## 许可证
MIT
