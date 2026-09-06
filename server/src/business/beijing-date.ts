// Node 侧统一以北京时间为准的"今天"。
// 数据库会话已钉死 Asia/Shanghai(db.ts),但服务器本地时区可能是 UTC
// (Docker 默认),直接用 new Date() 会让北京时间 0-8 点的月初/月末归属、
// 年度工龄判定、"不能晚于今天"校验错位一天。
export function beijingTodayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
