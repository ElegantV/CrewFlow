-- 放宽加班时段约束：开始时间不再限定 17:30，允许全天任意时刻开始（含跨零点），
-- 时长按开始到结束的分钟差计算，须为 2 至 6 个整小时（与 hours 列整小时约束保持一致）。
ALTER TABLE duty_records DROP CONSTRAINT duty_records_time_range_check;

ALTER TABLE duty_records
  ADD CONSTRAINT duty_records_time_range_check CHECK (
    (((EXTRACT(HOUR FROM end_time) * 60 + EXTRACT(MINUTE FROM end_time))
      - (EXTRACT(HOUR FROM start_time) * 60 + EXTRACT(MINUTE FROM start_time))
      + 1440) % 1440) BETWEEN 120 AND 360
  );
