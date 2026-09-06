import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

// 通知等异步任务以 void 丢弃 Promise,数据库抖动等场景抛出的异常不能带崩进程;
// 这里兜底记录并保持服务存活。
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

