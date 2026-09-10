-- 行内级别:默认"1级",仅超级管理员可在用户管理中修改,个人信息页只读。

ALTER TABLE users ALTER COLUMN bank_level SET DEFAULT '1级';

UPDATE users SET bank_level = '1级' WHERE bank_level IS NULL OR bank_level = '';