-- 行内级别改为固定五档：初级/中级/高级/主管/高级主管（仅超级管理员可在用户管理中修改）。
-- 旧的占位默认值"1级"归入"初级"；其他历史自定义值保留，由管理员在用户管理中按新选项修正。
ALTER TABLE users ALTER COLUMN bank_level SET DEFAULT '初级';

UPDATE users
SET bank_level = '初级', updated_at = now()
WHERE bank_level IS NULL OR bank_level = '' OR bank_level = '1级';
