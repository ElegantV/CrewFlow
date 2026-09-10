-- 行内处室/打卡地点/行内项目字典:个人信息页改为下拉选择,行内项目挂在处室下(先选处室再选项目)。
-- 用户表仍存文本(department/bank_project/attendance_location),选择器从字典取值,
-- 兼容历史自由文本数据;删除字典项时若被用户引用则拒绝。

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendance_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

INSERT INTO departments (name, sort_order) VALUES
  ('信息科技部', 1),
  ('开发一处', 2),
  ('开发二处', 3),
  ('运维保障组', 4),
  ('驻场开发组', 5),
  ('数据运营处', 6),
  ('风险管理处', 7),
  ('信贷审批处', 8),
  ('运营管理处', 9),
  ('综合管理部', 10)
ON CONFLICT (name) DO NOTHING;

INSERT INTO attendance_locations (name, sort_order) VALUES
  ('博瑞', 1),
  ('北京', 2),
  ('总行大楼', 3),
  ('科技中心', 4),
  ('分行营业部', 5),
  ('第二办公区', 6)
ON CONFLICT (name) DO NOTHING;

INSERT INTO bank_projects (department_id, name, sort_order)
SELECT d.id, p.name, p.sort FROM (VALUES
  ('信息科技部', '核心系统', 1),
  ('信息科技部', '信贷系统', 2),
  ('信息科技部', '渠道服务平台', 3),
  ('信息科技部', '数据仓库建设', 4),
  ('开发一处', '核心系统', 1),
  ('开发一处', '信贷系统', 2),
  ('开发一处', '接口服务开发', 3),
  ('开发二处', '渠道服务平台', 1),
  ('开发二处', '报表平台', 2),
  ('开发二处', '数据迁移工程', 3),
  ('运维保障组', '生产环境运维', 1),
  ('运维保障组', '监控告警平台', 2),
  ('运维保障组', '灾备演练', 3),
  ('驻场开发组', '客户现场交付', 1),
  ('驻场开发组', '定制化开发', 2),
  ('数据运营处', '数据治理', 1),
  ('数据运营处', '指标体系', 2),
  ('数据运营处', '报表平台', 3),
  ('风险管理处', '风险预警系统', 1),
  ('风险管理处', '合规检查', 2),
  ('信贷审批处', '信贷系统', 1),
  ('信贷审批处', '审批流程优化', 2),
  ('运营管理处', '运营指标看板', 1),
  ('运营管理处', '流程自动化', 2),
  ('综合管理部', '内部管理系统', 1),
  ('综合管理部', '考勤系统', 2)
) AS p(dep, name, sort)
JOIN departments d ON d.name = p.dep
ON CONFLICT (department_id, name) DO NOTHING;

-- 模拟分配:处室为空或不在字典的用户,按 id 顺序轮转分到字典处室。
WITH need AS (
  SELECT id, row_number() OVER (ORDER BY id) - 1 AS rn
  FROM users
  WHERE department IS NULL OR department NOT IN (SELECT name FROM departments)
), dict AS (
  SELECT name, row_number() OVER (ORDER BY sort_order, name) - 1 AS ord
  FROM departments
), cnt AS (SELECT count(*) AS n FROM departments)
UPDATE users u
SET department = d.name, updated_at = now()
FROM need n
JOIN dict d ON d.ord = n.rn % (SELECT n FROM cnt)
WHERE u.id = n.id;

-- 模拟分配:打卡地点为空或不在字典的用户,按 id 顺序轮转分到字典地点。
WITH need AS (
  SELECT id, row_number() OVER (ORDER BY id) - 1 AS rn
  FROM users
  WHERE attendance_location IS NULL OR attendance_location NOT IN (SELECT name FROM attendance_locations)
), dict AS (
  SELECT name, row_number() OVER (ORDER BY sort_order, name) - 1 AS ord
  FROM attendance_locations
), cnt AS (SELECT count(*) AS n FROM attendance_locations)
UPDATE users u
SET attendance_location = d.name, updated_at = now()
FROM need n
JOIN dict d ON d.ord = n.rn % (SELECT n FROM cnt)
WHERE u.id = n.id;

-- 模拟分配:项目为空或与所处室不匹配的用户,取所处室第一个项目。
UPDATE users u
SET bank_project = p.name, updated_at = now()
FROM bank_projects p
JOIN departments d ON d.id = p.department_id
WHERE u.department = d.name
  AND p.sort_order = (SELECT min(sort_order) FROM bank_projects WHERE department_id = p.department_id)
  AND (u.bank_project IS NULL OR u.bank_project NOT IN (
    SELECT name FROM bank_projects WHERE department_id = p.department_id
  ));