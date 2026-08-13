ALTER TABLE duty_records
  DROP CONSTRAINT duty_records_time_range_check,
  DROP CONSTRAINT duty_records_half_hour_check;

ALTER TABLE duty_records
  ADD CONSTRAINT duty_records_time_range_check
    CHECK (start_time = '17:30' AND end_time >= '19:30' AND end_time <= '23:30'),
  ADD CONSTRAINT duty_records_whole_hour_check
    CHECK (hours = trunc(hours) AND hours >= 2 AND hours <= 6);

