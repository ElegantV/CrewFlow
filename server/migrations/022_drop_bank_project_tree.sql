-- 撤销行内项目树形结构(020 引入):处室下只保留一层项目。
-- 既有子项目提升为顶级项目,再删除 parent_id 列。

UPDATE bank_projects SET parent_id = NULL WHERE parent_id IS NOT NULL;

ALTER TABLE bank_projects DROP COLUMN parent_id;