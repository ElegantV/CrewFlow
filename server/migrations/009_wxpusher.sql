-- wxpusher 消息推送绑定：用户扫码关注服务号后，轮询 scan-qrcode-uid 获取 uid 写入。
CREATE TABLE wxpusher_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) UNIQUE,
  uid varchar(64),
  qr_token varchar(32) NOT NULL,
  qr_data text,
  wxpusher_code varchar(64),
  follow_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wxpusher_bindings_uid_idx ON wxpusher_bindings (uid);
