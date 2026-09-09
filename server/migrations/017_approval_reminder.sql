-- 审批超时催办：记录每次催办时间，支持"超过24小时仍未处理则每24小时再提醒一次"。
ALTER TABLE approval_records
  ADD COLUMN last_reminded_at timestamptz;

CREATE INDEX approval_records_pending_created_idx
  ON approval_records (created_at)
  WHERE status = 'pending';
