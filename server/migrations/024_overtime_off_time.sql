-- 加班登记改为"下班时间 + 加班时长"口径(实际加班时间以此为准),
-- 取消开始/结束时间选择;start_time/end_time 列保留存放历史记录,新登记不再写入。

ALTER TABLE duty_records ADD COLUMN IF NOT EXISTS off_time time;

-- 016 的时段约束依赖 start/end 必填,新口径下不再适用,移除并放开可空。
ALTER TABLE duty_records DROP CONSTRAINT IF EXISTS duty_records_time_range_check;

ALTER TABLE duty_records ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE duty_records ALTER COLUMN end_time DROP NOT NULL;