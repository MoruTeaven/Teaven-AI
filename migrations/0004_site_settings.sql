-- 站点设置 — 存储全局配置项（如文件公共域名）
CREATE TABLE IF NOT EXISTS site_settings (
  key            TEXT PRIMARY KEY,                -- 配置键，固定为 'default'
  settings_json  TEXT NOT NULL DEFAULT '{}',      -- 完整的 SiteSettings JSON
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
