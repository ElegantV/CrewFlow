-- 记录订阅时客户端所处的环境（develop/trial/release），发送时按此环境匹配 miniprogram_state。
ALTER TABLE notification_subscriptions
  ADD COLUMN state varchar(20) NOT NULL DEFAULT 'formal';
