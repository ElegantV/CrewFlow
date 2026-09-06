-- 法定节假日日历：只存"非默认"日期（法定假与调休补班日），
-- 未入库的日期按周一至周五为工作日的默认规则判定。
-- source='auto' 来自 holiday-cn 自动同步；source='manual' 为管理员手工覆盖，
-- 同步任务永不覆盖 manual 行。2026 数据为迁移种子（国办发明电〔2025〕7号），
-- 保证升级当天与原静态表行为一致，此后由同步任务维护新年份。
CREATE TABLE IF NOT EXISTS calendar_days (
  date date PRIMARY KEY,
  day_type varchar(20) NOT NULL CHECK (day_type IN ('holiday', 'makeup')),
  name varchar(50) NOT NULL DEFAULT '',
  source varchar(20) NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO calendar_days (date, day_type, name, source) VALUES
  ('2026-01-01', 'holiday', '元旦', 'auto'),
  ('2026-01-02', 'holiday', '元旦', 'auto'),
  ('2026-01-03', 'holiday', '元旦', 'auto'),
  ('2026-01-04', 'makeup', '春节调休上班', 'auto'),
  ('2026-02-14', 'makeup', '春节调休上班', 'auto'),
  ('2026-02-15', 'holiday', '春节', 'auto'),
  ('2026-02-16', 'holiday', '春节', 'auto'),
  ('2026-02-17', 'holiday', '春节', 'auto'),
  ('2026-02-18', 'holiday', '春节', 'auto'),
  ('2026-02-19', 'holiday', '春节', 'auto'),
  ('2026-02-20', 'holiday', '春节', 'auto'),
  ('2026-02-21', 'holiday', '春节', 'auto'),
  ('2026-02-22', 'holiday', '春节', 'auto'),
  ('2026-02-23', 'holiday', '春节', 'auto'),
  ('2026-02-28', 'makeup', '春节调休上班', 'auto'),
  ('2026-04-04', 'holiday', '清明节', 'auto'),
  ('2026-04-05', 'holiday', '清明节', 'auto'),
  ('2026-04-06', 'holiday', '清明节', 'auto'),
  ('2026-05-01', 'holiday', '劳动节', 'auto'),
  ('2026-05-02', 'holiday', '劳动节', 'auto'),
  ('2026-05-03', 'holiday', '劳动节', 'auto'),
  ('2026-05-04', 'holiday', '劳动节', 'auto'),
  ('2026-05-05', 'holiday', '劳动节', 'auto'),
  ('2026-05-09', 'makeup', '劳动节调休上班', 'auto'),
  ('2026-06-19', 'holiday', '端午节', 'auto'),
  ('2026-06-20', 'holiday', '端午节', 'auto'),
  ('2026-06-21', 'holiday', '端午节', 'auto'),
  ('2026-09-20', 'makeup', '中秋节调休上班', 'auto'),
  ('2026-09-25', 'holiday', '中秋节', 'auto'),
  ('2026-09-26', 'holiday', '中秋节', 'auto'),
  ('2026-09-27', 'holiday', '中秋节', 'auto'),
  ('2026-10-01', 'holiday', '国庆节', 'auto'),
  ('2026-10-02', 'holiday', '国庆节', 'auto'),
  ('2026-10-03', 'holiday', '国庆节', 'auto'),
  ('2026-10-04', 'holiday', '国庆节', 'auto'),
  ('2026-10-05', 'holiday', '国庆节', 'auto'),
  ('2026-10-06', 'holiday', '国庆节', 'auto'),
  ('2026-10-07', 'holiday', '国庆节', 'auto'),
  ('2026-10-10', 'makeup', '国庆节调休上班', 'auto')
ON CONFLICT (date) DO NOTHING;
