-- 处室级审批配置 + 加班审批流。
-- 处室开关默认保持既有行为：请假需审批、加班无需审批；
-- 运行时若提交人未分配审批人（manager_id 为空），无论处室开关如何一律免审批。
ALTER TABLE departments
  ADD COLUMN leave_approval_required boolean NOT NULL DEFAULT true,
  ADD COLUMN overtime_approval_required boolean NOT NULL DEFAULT false;

-- 加班审批：duty_records 增加待审批/已驳回状态。
ALTER TABLE duty_records DROP CONSTRAINT duty_records_status_check;
ALTER TABLE duty_records ADD CONSTRAINT duty_records_status_check
  CHECK (status IN ('active', 'consumed', 'revoked', 'expired', 'pending', 'rejected'));

-- 驳回后允许同日重新登记；待审批记录仍占用当日唯一名额。
DROP INDEX IF EXISTS duty_records_one_active_per_day_idx;
CREATE UNIQUE INDEX duty_records_one_active_per_day_idx
  ON duty_records (user_id, duty_date)
  WHERE status NOT IN ('revoked', 'rejected');

-- 审批记录同时承载请假与加班：两个业务外键二选一。
ALTER TABLE approval_records
  ALTER COLUMN leave_request_id DROP NOT NULL,
  ADD COLUMN duty_record_id uuid REFERENCES duty_records(id);

ALTER TABLE approval_records
  ADD CONSTRAINT approval_records_target_check
  CHECK ((leave_request_id IS NOT NULL) <> (duty_record_id IS NOT NULL));

CREATE UNIQUE INDEX approval_records_duty_step_idx
  ON approval_records (duty_record_id, step_no)
  WHERE duty_record_id IS NOT NULL;
