-- AI 配置:单行表(id 恒为 1),管理员可在小程序内修改,免登服务器。
-- 空字符串字段表示"沿用 .env 默认值";api_key 入库后接口只返回脱敏形式。
CREATE TABLE IF NOT EXISTS ai_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model varchar(80) NOT NULL DEFAULT '',
  api_url varchar(300) NOT NULL DEFAULT '',
  api_key text NOT NULL DEFAULT '',
  max_tokens integer NOT NULL DEFAULT 400,
  max_reply_chars integer NOT NULL DEFAULT 120,
  system_prompt text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ai_config (id) VALUES (1) ON CONFLICT DO NOTHING;
