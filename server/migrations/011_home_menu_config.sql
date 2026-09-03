-- 首页菜单个性化:按用户存储菜单顺序与隐藏状态。
-- 形如 [{"key":"assistant","hidden":false},...];NULL 表示使用默认顺序。
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_menu_config jsonb;
