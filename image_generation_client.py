import requests
import time
import json
import webbrowser
from typing import Optional, Dict, Any
from dataclasses import dataclass
from enum import Enum
import logging

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class TaskStatus(Enum):
    """任务状态枚举"""
    PENDING = "pending"
    PROCESSING = "processing"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class ImageGenerationConfig:
    """图像生成配置"""
    api_url: str
    api_token: str
    timeout: int = 30 * 60  # 30分钟超时
    retry_interval: int = 5  # 5秒重试间隔
    max_retries: int = 3  # 单个请求最多重试3次


class ArksImageClient:
    """方舟模型异步图像生成客户端"""

    def __init__(self, config: ImageGenerationConfig):
        self.config = config
        self.headers = {
            "Authorization": f"Bearer {config.api_token}",
            "Content-Type": "application/json"
        }
        self.session = requests.Session()

    def _make_request(self, method: str, url: str, **kwargs) -> Dict[str, Any]:
        """发送HTTP请求，带重试机制"""
        for attempt in range(self.config.max_retries):
            try:
                response = self.session.request(
                    method=method,
                    url=url,
                    headers=self.headers,
                    timeout=10,
                    **kwargs
                )
                response.raise_for_status()
                return response.json()
            except requests.exceptions.RequestException as e:
                if attempt < self.config.max_retries - 1:
                    logger.warning(f"请求失败 (重试 {attempt + 1}/{self.config.max_retries}): {e}")
                    time.sleep(2 ** attempt)  # 指数退避
                else:
                    logger.error(f"请求最终失败: {e}")
                    raise

    def submit_task(self, prompt: str, **kwargs) -> str:
        """提交图像生成任务
        
        Args:
            prompt: 图像描述文本
            **kwargs: 其他参数（model, size, num_images_per_prompt等）
            
        Returns:
            task_id: 任务ID
        """
        # 准备请求体
        payload = {
            "prompt": prompt,
            "model": kwargs.get("model", "Qwen-Image"),
            "num_images_per_prompt": kwargs.get("num_images_per_prompt", 1),
            "num_inference_steps": kwargs.get("num_inference_steps", 4),
            "cfg_scale": kwargs.get("cfg_scale", 1.0),
            "negative_prompt": kwargs.get("negative_prompt", ""),
        }
        
        # 处理图像尺寸
        size = kwargs.get("size", "1024x1024")
        if "x" in size:
            width, height = map(int, size.split("x"))
            payload["width"] = width
            payload["height"] = height
        else:
            payload["width"] = kwargs.get("width", 1024)
            payload["height"] = kwargs.get("height", 1024)
        
        # 可选参数
        if "seed" in kwargs:
            payload["seed"] = kwargs["seed"]
        if "lora_weights" in kwargs:
            payload["lora_weights"] = kwargs["lora_weights"]
        
        logger.info(f"提交任务: {payload['model']}")
        logger.debug(f"Prompt: {prompt[:100]}...")
        
        try:
            result = self._make_request("POST", self.config.api_url, json=payload)
            
            if "error" in result:
                raise ValueError(f"API错误: {result['error']} - {result.get('message', '未知错误')}")
            
            task_id = result.get("task_id")
            if not task_id:
                raise ValueError("响应中未找到 task_id")
            
            logger.info(f"✅ 任务已提交，ID: {task_id}")
            return task_id
            
        except requests.exceptions.HTTPError as e:
            logger.error(f"❌ HTTP错误 {e.response.status_code}")
            if e.response.status_code == 404:
                logger.error("API端点不存在。请检查:")
                logger.error(f"  - API URL: {self.config.api_url}")
                logger.error("  - API令牌是否有效")
                logger.error("  - 方舟模型服务是否在线")
            raise

    def poll_task(self, task_id: str, open_browser: bool = True) -> Dict[str, Any]:
        """轮询任务状态
        
        Args:
            task_id: 任务ID
            open_browser: 完成时是否在浏览器中打开结果
            
        Returns:
            任务结果
        """
        status_url = f"{self.config.api_url.rsplit('/', 1)[0]}/task/{task_id}"
        max_attempts = self.config.timeout // self.config.retry_interval
        attempt = 0
        
        logger.info(f"开始轮询任务状态 (超时: {self.config.timeout}秒)...")
        
        while attempt < max_attempts:
            attempt += 1
            
            try:
                result = self._make_request("GET", status_url)
                
                if "error" in result:
                    logger.error(f"❌ 任务错误: {result['error']}")
                    raise ValueError(f"{result['error']}: {result.get('message', '未知错误')}")
                
                status = result.get("status", "unknown")
                logger.info(f"[轮询 {attempt}/{max_attempts}] 状态: {status}")
                
                if status == "success":
                    return self._handle_success(result, task_id, open_browser)
                elif status in ["failed", "cancelled"]:
                    logger.error(f"❌ 任务已{status}: {result.get('message', '无详情')}")
                    self._save_task_result(task_id, result)
                    return result
                else:
                    # 继续轮询
                    time.sleep(self.config.retry_interval)
                    continue
                    
            except requests.exceptions.RequestException as e:
                logger.warning(f"轮询请求失败: {e}，重试...")
                time.sleep(self.config.retry_interval)
                continue
        
        logger.error(f"⏰ 达到最大轮询次数 ({max_attempts})")
        return {"status": "timeout", "message": "超过最大等待时间"}

    def _handle_success(self, result: Dict[str, Any], task_id: str, open_browser: bool) -> Dict[str, Any]:
        """处理任务成功"""
        output = result.get("output", {})
        
        # 计算任务耗时
        started_at = result.get("started_at", 0)
        completed_at = result.get("completed_at", 0)
        duration = (completed_at - started_at) / 1000 if both else 0
        
        if "file_url" in output:
            file_url = output["file_url"]
            logger.info(f"✅ 任务成功!")
            logger.info(f"🔗 下载链接: {file_url}")
            logger.info(f"⏱️ 耗时: {duration:.2f}秒")
            
            if open_browser:
                webbrowser.open(file_url)
                logger.info("📂 已在浏览器中打开结果")
                
        elif "text_result" in output:
            logger.info(f"📝 文本结果: {output['text_result']}")
        else:
            logger.warning("⚠️ 输出中未找到预期的文件或文本结果")
        
        self._save_task_result(task_id, result)
        return result

    def _save_task_result(self, task_id: str, result: Dict[str, Any]) -> None:
        """保存任务结果到文件"""
        task_file = f"task_{task_id}.json"
        try:
            with open(task_file, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=4, ensure_ascii=False)
            logger.info(f"💾 任务结果已保存到: {task_file}")
        except IOError as e:
            logger.error(f"保存文件失败: {e}")

    def close(self):
        """关闭会话"""
        self.session.close()


def main():
    """主函数示例"""
    # 配置
    config = ImageGenerationConfig(
        # 尝试多个可能的端点
        api_url="https://ai.gitee.com/api/v1/image_generation",  # 调整端点
        api_token="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    )
    
    client = ArksImageClient(config)
    
    try:
        # 提交任务
        task_id = client.submit_task(
            prompt="一副典雅庄重的对联悬挂于厅堂之中，房间是个安静古典的中式布置，"
                   "桌子上放着一些青花瓷，对联上左书'义本生知人机同道善思新'，"
                   "右书'通云赋智乾坤启数高志远'，横批'智启通义'，字体飘逸，"
                   "中间挂在一着一副中国风的画作，内容是岳阳楼。",
            model="Qwen-Image",
            size="1024x1024",
            num_images_per_prompt=1,
            num_inference_steps=4,
            cfg_scale=1.0,
            negative_prompt="指导模型避免生成所描述的内容。"
        )
        
        # 轮询任务结果
        result = client.poll_task(task_id, open_browser=True)
        
        if result.get("status") == "success":
            logger.info("🎉 任务完成!")
        
    except Exception as e:
        logger.error(f"发生错误: {e}")
    finally:
        client.close()


if __name__ == "__main__":
    main()
