-- 用户昵称字段支持
-- 添加 nickname 字段用于显示名称，与 name（系统名称）区分

ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
