// Playwright workers=1 时多个 spec 文件运行在同一进程,而 src/db.ts 的连接池
// 是模块级单例,app.close() 的 onClose 钩子会把它 end 掉,导致后续文件的
// buildApp 拿不到连接。因此这里按进程缓存单个 app 实例供所有 spec 复用,
// 测试结束不主动 close(由 Playwright 终止 worker 进程回收)。
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

let cached: Promise<FastifyInstance> | null = null;

export async function getTestApp() {
  if (!cached) {
    cached = (async () => {
      const app = await buildApp();
      await app.listen({ port: 0, host: "127.0.0.1" });
      return app;
    })();
  }
  return cached;
}

export function getBaseUrl(app: FastifyInstance) {
  const address = app.server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}
