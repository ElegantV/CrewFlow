import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
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
import { notificationRoutes } from "./routes/notifications.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

export async function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true });

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
      return { status: "ok" };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({ status: "unavailable" });
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
  await app.register(notificationRoutes, { prefix: "/api/v1/notifications" });

  app.addHook("onClose", async () => {
    await db.end();
  });

  return app;
}
