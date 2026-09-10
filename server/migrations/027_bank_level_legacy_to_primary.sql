-- 历史行内级别统一收敛到新五档的默认值"初级"：
-- 非五档的自定义历史值（如"员工""行长"）与空值一并归入"初级"，由管理员后续按新选项调整。
UPDATE users
SET bank_level = '初级', updated_at = now()
WHERE bank_level IS NULL
   OR bank_level = ''
   OR bank_level NOT IN ('初级', '中级', '高级', '主管', '高级主管');
