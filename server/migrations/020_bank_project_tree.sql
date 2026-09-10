-- 行内项目树形化:项目可挂到同处室的项目下(父项目),形成 处室→项目→子项目 层级,
-- 便于数据量大时按树浏览维护。parent_id 为空表示该处室下的顶级项目。

ALTER TABLE bank_projects ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES bank_projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS bank_projects_parent_id_idx ON bank_projects (parent_id);