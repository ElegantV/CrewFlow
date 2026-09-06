import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { approvalRoutes } from "./routes/approvals.js";
import { leaveRoutes } from "./routes/leaves.js";
import { meRoutes } from "./routes/me.js";
import { overtimeRoutes } from "./routes/overtime.js";
import { situationRoutes } from "./routes/situation.js";
import { contactRoutes } from "./routes/contacts.js";
import { wxpusherRoutes } from "./routes/wxpusher.js";
import { aiRoutes } from "./routes/ai.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export async function buildApp() {
  // 只信任回环与私网来源的 X-Forwarded-For(Caddy 在同一主机/内网反代);
  // 全盘信任会让公网客户端伪造 XFF 轮换 IP,绕过登录/AI 等基于 IP 的限流。
  const app = Fastify({ logger: true, trustProxy: "loopback,uniquelocal" });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Unhandled API error");
    if (reply.sent) return;

    const statusCodeValue = error && typeof error === "object" && "statusCode" in error
      ? error.statusCode
      : undefined;
    const statusCode = typeof statusCodeValue === "number" && statusCodeValue >= 400
      ? statusCodeValue
      : 500;
    const errorMessage = error instanceof Error ? error.message : "请求失败";
    const clientError = statusCode >= 500
      ? { code: "INTERNAL_SERVER_ERROR", message: "服务器暂时不可用，请稍后重试" }
      : { code: "REQUEST_FAILED", message: errorMessage };
    reply.code(statusCode).send(clientError);
  });
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ code: "NOT_FOUND", message: "接口不存在" });
  });

  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
  });
  await app.register(jwt, { secret: config.JWT_SECRET });
  // 全局限流:正常使用远低于此阈值,仅拦截异常刷量;登录等敏感接口各自叠加更严限制。
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      code: "RATE_LIMITED",
      message: "请求过于频繁，请稍后重试",
    }),
  });

  app.decorate("authenticate", async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
      if (request.user.status === "disabled") {
        await reply.code(403).send({ code: "ACCOUNT_DISABLED", message: "账号已停用" });
      }
    } catch {
      await reply.code(401).send({ code: "UNAUTHORIZED", message: "请重新登录" });
    }
  });

  app.decorateRequest("actor", undefined);

  app.get("/health", async (_request, reply) => {
    try {
      await db.query("SELECT 1");
      return { status: "ok", db: true };
    } catch (error) {
      app.log.error(error);
      // API 进程存活但数据库不可达:返回 200 让探活区分"服务挂"与"库挂"。
      return { status: "degraded", db: false };
    }
  });

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(meRoutes, { prefix: "/api/v1/me" });
  await app.register(overtimeRoutes, { prefix: "/api/v1/overtime" });
  await app.register(situationRoutes, { prefix: "/api/v1/situation" });
  await app.register(contactRoutes, { prefix: "/api/v1/contacts" });
  await app.register(leaveRoutes, { prefix: "/api/v1/leaves" });
  await app.register(approvalRoutes, { prefix: "/api/v1/approvals" });
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  await app.register(wxpusherRoutes, { prefix: "/api/v1/wxpusher" });
  await app.register(aiRoutes, { prefix: "/api/v1/ai" });

  app.addHook("onClose", async () => {
    await db.end();
  });

  return app;
}
