-- 清理遗留的微信订阅消息表：上线后一直由 wxpusher 承担消息推送，
-- notification_subscriptions / notification_send_log 从未被写入，属死表，删除避免误读。
DROP TABLE IF EXISTS notification_send_log;
DROP TABLE IF EXISTS notification_subscriptions;
