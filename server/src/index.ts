import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

// 通知等异步任务以 void 丢弃 Promise,数据库抖动等场景抛出的异常不能带崩进程;
// 这里兜底记录并保持服务存活。
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});

// 优雅停机:容器滚动发布收到 SIGTERM 后停止接新请求,等在途请求完成,
// 并经 onClose 钩子关闭 DB 连接池,而不是被硬切。
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "收到停机信号,开始优雅关闭");
    app.close()
      .then(() => process.exit(0))
      .catch((error) => {
        app.log.error(error);
        process.exit(1);
      });
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

