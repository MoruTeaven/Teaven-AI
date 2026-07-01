import type { ImageSizePreset } from "../types";

/**
 * 根据 aspect_ratio 和 quality 从支持的尺寸列表中匹配具体尺寸。
 * 匹配优先级：
 * 1. aspect_ratio + quality 完全匹配
 * 2. aspect_ratio 匹配（忽略 quality）
 * 3. quality 匹配（忽略 aspect_ratio）
 * 4. 返回 undefined
 */
export function resolveImageSize(
  aspectRatio: string | undefined,
  quality: string | undefined,
  supportedSizes: ImageSizePreset[] | undefined
): { width: number; height: number } | undefined {
  if (!supportedSizes || supportedSizes.length === 0) {
    return undefined;
  }

  // 1. 完全匹配 aspect_ratio + quality
  if (aspectRatio && quality) {
    const exactMatch = supportedSizes.find(
      (preset) => preset.name === aspectRatio && preset.quality === quality
    );
    if (exactMatch) {
      return { width: exactMatch.width, height: exactMatch.height };
    }
  }

  // 2. 只匹配 aspect_ratio
  if (aspectRatio) {
    const ratioMatch = supportedSizes.find((preset) => preset.name === aspectRatio);
    if (ratioMatch) {
      return { width: ratioMatch.width, height: ratioMatch.height };
    }
  }

  // 3. 只匹配 quality
  if (quality) {
    const qualityMatch = supportedSizes.find((preset) => preset.quality === quality);
    if (qualityMatch) {
      return { width: qualityMatch.width, height: qualityMatch.height };
    }
  }

  return undefined;
}
