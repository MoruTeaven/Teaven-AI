-- API Key 允许的模型类型（模态）。
--
-- 用户创建密钥时可多选：文字模型(text)、生图模型(image)、视频模型(video)、文件模型(file)。
-- 未设置（NULL）时表示不限制，向后兼容。

ALTER TABLE api_keys ADD COLUMN allowed_modalities TEXT;
