CREATE TABLE notification_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  template_id varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_id)
);

CREATE TABLE notification_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  template_id varchar(64) NOT NULL,
  leave_request_id uuid REFERENCES leave_requests(id),
  status varchar(20) NOT NULL,
  errcode integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_subscriptions_user_idx ON notification_subscriptions (user_id);
CREATE INDEX notification_send_log_leave_idx ON notification_send_log (leave_request_id);
