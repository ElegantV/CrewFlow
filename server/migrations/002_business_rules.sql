ALTER TABLE users DROP CONSTRAINT users_role_check;
UPDATE users SET role = CASE role
  WHEN 'employee' THEN 'user'
  WHEN 'approver' THEN 'admin'
  WHEN 'admin' THEN 'super_admin'
  ELSE role
END;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'admin', 'super_admin'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

ALTER TABLE users
  ADD COLUMN manager_id uuid REFERENCES users(id),
  ADD COLUMN agent_user_id uuid REFERENCES users(id),
  ADD CONSTRAINT users_manager_not_self CHECK (manager_id IS NULL OR manager_id <> id),
  ADD CONSTRAINT users_agent_not_self CHECK (agent_user_id IS NULL OR agent_user_id <> id);

CREATE INDEX users_manager_idx ON users (manager_id) WHERE manager_id IS NOT NULL;

ALTER TABLE duty_records
  ADD COLUMN start_time time NOT NULL DEFAULT '17:30',
  ADD COLUMN end_time time;

UPDATE duty_records
SET end_time = start_time + (hours * interval '1 hour');

ALTER TABLE duty_records
  ALTER COLUMN end_time SET NOT NULL,
  ADD CONSTRAINT duty_records_time_range_check
    CHECK (start_time = '17:30' AND end_time > start_time AND end_time <= '23:30'),
  ADD CONSTRAINT duty_records_half_hour_check
    CHECK ((hours * 2) = trunc(hours * 2));

CREATE UNIQUE INDEX duty_records_one_active_per_day_idx
  ON duty_records (user_id, duty_date)
  WHERE status <> 'revoked';

ALTER TABLE approval_records
  ADD CONSTRAINT approval_records_no_self_approval
  CHECK (approver_id IS NOT NULL);
