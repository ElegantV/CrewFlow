CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  openid text NOT NULL UNIQUE,
  unionid text UNIQUE,
  employee_no varchar(64) UNIQUE,
  name varchar(80),
  role varchar(20) NOT NULL DEFAULT 'employee'
    CHECK (role IN ('employee', 'approver', 'admin')),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE duty_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  duty_date date NOT NULL,
  hours numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  remaining_hours numeric(5,2) NOT NULL CHECK (remaining_hours >= 0),
  content varchar(200) NOT NULL,
  expires_at date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining_hours <= hours)
);

CREATE INDEX duty_records_user_date_idx ON duty_records (user_id, duty_date DESC);
CREATE INDEX duty_records_expiry_idx ON duty_records (user_id, expires_at) WHERE status = 'active';

CREATE TABLE leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES users(id),
  agent_user_id uuid REFERENCES users(id),
  leave_type varchar(30) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  start_period varchar(10) NOT NULL DEFAULT 'day'
    CHECK (start_period IN ('morning', 'afternoon', 'day')),
  end_period varchar(10) NOT NULL DEFAULT 'day'
    CHECK (end_period IN ('morning', 'afternoon', 'day')),
  requested_days numeric(6,2) NOT NULL CHECK (requested_days > 0),
  requested_hours numeric(7,2) NOT NULL DEFAULT 0 CHECK (requested_hours >= 0),
  reason varchar(500),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX leave_requests_applicant_idx ON leave_requests (applicant_id, submitted_at DESC);
CREATE INDEX leave_requests_status_idx ON leave_requests (status, submitted_at);

CREATE TABLE approval_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id uuid NOT NULL REFERENCES leave_requests(id),
  step_no integer NOT NULL CHECK (step_no > 0),
  approver_id uuid NOT NULL REFERENCES users(id),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  comment varchar(500),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leave_request_id, step_no)
);

CREATE INDEX approval_records_approver_idx ON approval_records (approver_id, status, created_at);

CREATE TABLE timeoff_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leave_request_id uuid NOT NULL REFERENCES leave_requests(id),
  duty_record_id uuid NOT NULL REFERENCES duty_records(id),
  hours numeric(5,2) NOT NULL CHECK (hours > 0),
  status varchar(20) NOT NULL DEFAULT 'allocated'
    CHECK (status IN ('allocated', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  UNIQUE (leave_request_id, duty_record_id)
);

CREATE TABLE timeoff_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  duty_record_id uuid REFERENCES duty_records(id),
  leave_request_id uuid REFERENCES leave_requests(id),
  entry_type varchar(20) NOT NULL
    CHECK (entry_type IN ('earn', 'use', 'refund', 'expire', 'adjust')),
  amount_hours numeric(7,2) NOT NULL CHECK (amount_hours <> 0),
  note varchar(300),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX timeoff_ledger_user_idx ON timeoff_ledger (user_id, created_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action varchar(80) NOT NULL,
  entity_type varchar(50) NOT NULL,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);

