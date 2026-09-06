-- 请假重叠与一次性假期的数据库层兜底约束。
--
-- 业务层已有 SELECT ... FOR UPDATE 预检(routes/leaves.ts),但 READ COMMITTED 下
-- 两个并发事务各自快照都看不到对方未提交的 INSERT,行锁锁不住"幻影插入",
-- 双击/重试即可造出两条重叠申请。以下约束把该竞态在数据库层封死:
-- 若存量数据已存在同申请人重叠的 pending/approved 记录,本迁移会失败,
-- 需先人工清理冲突数据后重跑。

-- btree_gist 让 EXCLUDE 约束支持 applicant_id 的等值条件(btree_gist 为 PG13+ 可信扩展,库属主即可安装)。
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 同一申请人在 pending/approved 状态下,请假日期区间(含两端)不得重叠。
ALTER TABLE leave_requests
  ADD CONSTRAINT leave_requests_no_overlap
  EXCLUDE USING gist (
    applicant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('pending', 'approved'));

-- 婚假/陪产假强制一次性休完,每人同时最多一条有效申请。
CREATE UNIQUE INDEX leave_requests_fixed_type_unique
  ON leave_requests (applicant_id, leave_type)
  WHERE leave_type IN ('marriage', 'paternity')
    AND status IN ('pending', 'approved');
