-- 字典表补 updated_at 列(019 迁移初版遗漏,已执行库通过本迁移补齐)。

ALTER TABLE departments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE attendance_locations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bank_projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();