import { defineConfig } from "@playwright/test";

// Playwright 仅用于 API 集成测试(request),不加载浏览器;
// 由测试文件自行启动 Fastify 并监听随机端口,无需 webServer 配置。
// 运行: npm run test:api (脚本中注入 NODE_ENV 与测试库 DATABASE_URL)。
export default defineConfig({
  testDir: "./test/playwright",
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
});
