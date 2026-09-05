-- AI 深度问答开关:默认关闭,开启后助手在规则未命中时可将问题转交大模型回答。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_agent_enabled boolean NOT NULL DEFAULT false;
