"""
config_example.py - 配置示例文件

复制此文件为 config.py 并填入你的实际配置
"""

import os
from image_generation_client import ImageGenerationConfig

# 从环境变量读取（推荐用于敏感信息）
API_TOKEN = os.getenv("GITEE_AI_API_TOKEN", "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")

# 创建配置对象
# 注意：需要根据实际API端点调整 api_url
config = ImageGenerationConfig(
    # API配置 - 需要确认正确的端点
    api_url="https://ai.gitee.com/api/v1/image_generation",
    api_token=API_TOKEN,
    
    # 超时设置
    timeout=30 * 60,  # 30分钟
    
    # 轮询设置
    retry_interval=5,  # 每5秒检查一次状态
    
    # 重试设置
    max_retries=3     # 单个请求失败后最多重试3次
)

# 可选的高级配置
ADVANCED_CONFIG = {
    "long_task_config": ImageGenerationConfig(
        api_url="https://ai.gitee.com/api/v1/image_generation",
        api_token=API_TOKEN,
        timeout=60 * 60,  # 1小时
        retry_interval=10,
        max_retries=5
    ),
    
    "fast_task_config": ImageGenerationConfig(
        api_url="https://ai.gitee.com/api/v1/image_generation",
        api_token=API_TOKEN,
        timeout=5 * 60,   # 5分钟
        retry_interval=2,
        max_retries=2
    )
}

if __name__ == "__main__":
    # 验证配置
    print(f"API URL: {config.api_url}")
    print(f"Token: {config.api_token[:10]}...")
    print(f"Timeout: {config.timeout}s")
    print(f"Retry interval: {config.retry_interval}s")
