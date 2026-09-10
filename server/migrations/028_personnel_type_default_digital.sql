-- 注册默认人员类型改为"数科"（digital）。只改列默认值，不影响已完成资料的用户。
ALTER TABLE users ALTER COLUMN personnel_type SET DEFAULT 'digital';

-- 尚未完善资料的存量注册用户（待激活且无姓名）仍是旧默认值"厂商"，一并归入"数科"。
UPDATE users
SET personnel_type = 'digital', updated_at = now()
WHERE status = 'pending' AND name IS NULL AND personnel_type = 'vendor';
