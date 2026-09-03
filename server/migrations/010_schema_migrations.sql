-- 迁移版本记录表：让后续迁移可以幂等、可追溯地执行，不再依赖
-- docker-entrypoint-initdb.d（该机制只在空数据卷首次启动时运行一次）。
--
-- 本文件自身必须保持幂等：
--   1. 全新部署：initdb 按顺序跑完 001~010，版本表建成并回填 001~009；
--   2. 存量部署：数据卷非空，initdb 不会执行，改为 `npm run migrate` 执行本文件，
--      同样建表并回填，之后 011+ 由 migrate 正常推进。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version varchar(255) PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- 回填历史迁移。checksum 留空表示"补录的历史版本，不与文件校验"。
INSERT INTO schema_migrations (version, checksum)
VALUES
  ('001_initial', ''),
  ('002_business_rules', ''),
  ('003_overtime_rounding', ''),
  ('004_remove_proof_upload', ''),
  ('005_approval_result_signature', ''),
  ('006_user_profile', ''),
  ('007_notification_subscribe', ''),
  ('008_notification_state', ''),
  ('009_wxpusher', '')
ON CONFLICT (version) DO NOTHING;
